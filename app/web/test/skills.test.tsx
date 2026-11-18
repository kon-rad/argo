import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Skills from '../src/routes/skills/Skills.js';
import { DraftEditor } from '../src/routes/skills/DraftEditor.js';
import { skillsApi } from '../src/routes/skills/api.js';
import { ApiError } from '../src/lib/http.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const policy = { file: '.agents/skills-policy.yaml', exists: false, valid: true, errors: [], warnings: [], digest: null, revision: null, dirty: null };
const candidate = {
  id: 'private:report', name: 'report', source: 'private', root: '.agents/skills', relPath: 'report', category: null, description: 'Writes the weekly report.',
  valid: true, errors: [], warnings: [], digest: `sha256:${'a'.repeat(64)}`, files: 2, bytes: 120, revision: 'b'.repeat(40), dirty: false, tracked: true,
  linkOf: null, effective: true, shadowedBy: null, metadata: { version: null, owner: null, license: null, depends: [], requires: { bins: [], env: [] } },
};
const row = (name: string, over: Record<string, unknown> = {}) => ({
  name, effective: { ...candidate, id: `private:${name}`, name }, candidates: [{ ...candidate, id: `private:${name}`, name }],
  flags: { override: false, duplicate: false, invalid: false, dirty: false }, lifecycle: { status: 'active', replacement: null, note: null },
  assigned: 0, denied: 0, references: 0, ...over,
});

function stub(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

function renderAt(view: Parameters<typeof Skills>[0]['view'], path = '/skills') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const route = view === 'agent' ? '/skills/agents/:agent' : view === 'detail' ? '/skills/s/:name' : '*';
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={<Skills view={view} />} /></Routes></MemoryRouter></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Skills library', () => {
  it('shows a failed forced rescan while retaining stale data, and retries a forced rescan', async () => {
    let forced = 0;
    stub((url) => {
      if (url.includes('refresh=1') && ++forced === 1) return json({ error: { message: 'rescan unavailable' } }, 500);
      return json({ mode: 'legacy', policy, roots: [], skills: [row('report')], generatedAt: '2026-01-01T00:00:00Z' });
    });
    renderAt('library');
    await screen.findByRole('link', { name: 'report' });
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/rescan unavailable/);
    expect(screen.getByRole('link', { name: 'report' })).toBeTruthy();
    expect(screen.getByText(/previous catalog/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(forced).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('shows the empty state and the legacy banner for an empty catalog', async () => {
    stub(() => json({ mode: 'legacy', policy, roots: [], skills: [], generatedAt: '2026-01-01T00:00:00Z' }));
    renderAt('library');
    expect(await screen.findByText(/No skills found/)).toBeTruthy();
    expect(screen.getByText(/every agent sees its runtime's whole skill folder/i)).toBeTruthy();
  });

  it('shows the server error with a retry', async () => {
    let calls = 0;
    stub(() => { calls++; return json({ error: { message: 'policy file unreadable' } }, 500); });
    renderAt('library');
    expect((await screen.findByRole('alert')).textContent).toMatch(/policy file unreadable/);
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByRole('alert');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('filters by search and flag, and shows overrides', async () => {
    stub(() => json({ mode: 'managed', policy: { ...policy, exists: true }, roots: [], generatedAt: '2026-01-01T00:00:00Z',
      skills: [row('report', { flags: { override: true, duplicate: false, invalid: false, dirty: false } }), row('ingest')] }));
    renderAt('library');
    expect((await screen.findAllByText('report')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('override').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'ingest' } });
    expect(screen.queryAllByText('report')).toHaveLength(0);
    expect(screen.getAllByText('ingest').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Flag'), { target: { value: 'override' } });
    expect(screen.queryAllByText('ingest')).toHaveLength(0);
  });
});

describe('Skills agent profile links', () => {
  it.each([false, true])('shows the org profile link only when org is enabled: %s', async (org) => {
    stub((url) => url.includes('/meta') ? json({ modules: org ? ['skills', 'org'] : ['skills'] }) : json({
      agent: { name: 'alpha', team: 'media', runtime: 'codex', support: 'catalog-only', supportNote: 'Catalog only.', assigned: 0, references: 0 },
      cells: [], notes: [], mode: 'managed',
    }));
    renderAt('agent', '/skills/agents/alpha');
    await screen.findByRole('heading', { name: 'alpha' });
    if (org) expect(await screen.findByRole('link', { name: 'Profile' })).toBeTruthy();
    else expect(screen.queryByRole('link', { name: 'Profile' })).toBeNull();
  });
});

describe('Skills machines', () => {
  it('says a machine is unknown until it acknowledges', async () => {
    stub(() => json({ staleAfterHours: 24, mode: 'managed', notes: [], hosts: [] }));
    renderAt('machines', '/skills/machines');
    expect(await screen.findByText(/No machines yet/)).toBeTruthy();
    expect(screen.getByText(/Pushing to Git is not a sync/)).toBeTruthy();
  });
});

it('requires a fresh preview after saving draft content, and binds export to the new digest', async () => {
  let digest=`sha256:${'a'.repeat(64)}`;
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:10,exec:false,sha256:'a'.repeat(64),kind:'text' as const}],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'draftFile').mockResolvedValue({name:'report',id:'draft:report',path:'SKILL.md',content:'Original content',kind:'text',truncated:false,sha256:'a'.repeat(64),version:'a'.repeat(64),exec:false} as any);
  vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async()=>{digest=`sha256:${'b'.repeat(64)}`;return{draft:draft()};});
  const preview=vi.spyOn(skillsApi,'preview').mockImplementation(async()=>({preview:{fingerprint:`sha256:${'c'.repeat(64)}`,kind:'update',skill:'report',summary:'Update report',baseDigest:null,baseRevision:null,targetDigest:digest,validation:{valid:true,errors:[],warnings:[]},affectedAgents:[],affectedHosts:[],dependents:[],blocked:[],files:[],policyDiff:null,runningSessions:'After sync',rollbackTarget:null} as any}));
  const propose=vi.spyOn(skillsApi,'propose').mockImplementation(async()=>({change:{id:'fixture-change'} as any}));
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Prepare update'}));
  fireEvent.click(screen.getByRole('button',{name:'Show what would change'}));
  await screen.findByRole('button',{name:'Export for review'});
  fireEvent.change(screen.getByRole('textbox',{name:'SKILL.md'}),{target:{value:'Changed after preview'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Export for review'})).toBeNull());
  expect(propose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Prepare update'}));
  fireEvent.click(screen.getByRole('button',{name:'Show what would change'}));
  fireEvent.click(await screen.findByRole('button',{name:'Export for review'}));
  await waitFor(()=>expect(propose).toHaveBeenCalledWith(expect.objectContaining({expectedDraftDigest:digest,expectedPreviewDigest:`sha256:${'c'.repeat(64)}`})));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/Machines receive it only after they sync/)).toBeTruthy();
});
it('labels a catalog-matching change without claiming merge provenance or machine use', async () => {
  stub(url=>url.includes('/drafts')?json({drafts:[]}):json({changes:[{id:'fixture',kind:'update',skill:'report',status:'pending',createdAt:'2026-01-01T00:00:00Z',preview:{summary:'Update report'}}]}));
  renderAt('changes','/skills/changes');
  expect(await screen.findByText('catalog matches; review or merge provenance unverified')).toBeTruthy();
  expect(screen.queryByText(/merged/)).toBeNull();
});

it('labels the effective catalog source without claiming use and shows failed view state',async()=>{
 stub(()=>json({name:'report',row:row('report'),selected:candidate,instructions:'# Report',files:[],history:[],agents:[],dependents:[],hosts:[{host:'fixture-host',agent:'alpha',runtime:'codex',observed:candidate.digest,state:'unknown',viewStatus:'failed',receivedAt:'2026-01-01T00:00:00Z'}],drafts:[],changes:[],mode:'managed'}));
 renderAt('detail','/skills/s/report');
 expect(await screen.findByText('effective source')).toBeTruthy();
 expect(screen.queryByText('in use')).toBeNull();
 expect(await screen.findByText('view failed')).toBeTruthy();
 expect(screen.queryByText('match')).toBeNull();
});
it('shows unresolved assigned-package reasons on a failed machine view',async()=>{
 stub(()=>json({staleAfterHours:24,mode:'managed',notes:[],hosts:[{host:'fixture-host',display:'Fixture host',status:'failed',lastAck:'2026-01-01T00:00:00Z',views:[{agent:'alpha',runtime:'codex',viewDigest:null,generatedAt:null,receivedAt:'2026-01-01T00:00:00Z',status:'failed',error:'Unresolved assignments',excluded:[{name:'report',reason:'pinned package missing'}],skills:[],missing:[],dirty:[]}]}]}));
 renderAt('machines','/skills/machines');
 expect(await screen.findByText('report: pinned package missing')).toBeTruthy();
 expect(screen.getByText('last sync failed')).toBeTruthy();
});

it('refreshes a409 draft conflict while retaining unsaved text and requires an explicit reviewed retry',async()=>{
  let serverContent='Original file', hash='a'.repeat(64);
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:serverContent.length,exec:false,sha256:hash,kind:'text' as const}],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${hash}`});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  const reads=vi.spyOn(skillsApi,'draftFile').mockImplementation(async()=>({id:'draft:report',path:'SKILL.md',size:serverContent.length,content:serverContent,kind:'text',truncated:false,sha256:hash,version:hash,exec:false}));
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async()=>{
    serverContent='First owner winning edit';hash='b'.repeat(64);
    throw new ApiError(409,'The draft file changed since you loaded it');
  });
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  const editor=await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(editor,{target:{value:'Second owner unsaved edit'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByRole('region',{name:'Draft file conflict'});
  await waitFor(()=>expect((editor as HTMLTextAreaElement).value).toBe('First owner winning edit'));
  expect((screen.getByRole('textbox',{name:'Your unsaved draft changes'}) as HTMLTextAreaElement).value).toBe('Second owner unsaved edit');
  expect(writes).toHaveBeenCalledTimes(1);expect(writes).toHaveBeenCalledWith('report',expect.objectContaining({expectedVersion:'a'.repeat(64)}));
  expect(reads.mock.calls.length).toBeGreaterThan(1);
  expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(true);
  expect(serverContent).toBe('First owner winning edit');
  writes.mockImplementation(async(_name,body)=>{
    expect(body.expectedVersion).toBe('b'.repeat(64));serverContent=body.content;hash='c'.repeat(64);return{draft:draft()};
  });
  await waitFor(()=>expect((screen.getByRole('button',{name:'Restore my text and mode to merge'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Restore my text and mode to merge'}));
  expect((editor as HTMLTextAreaElement).value).toBe('Second owner unsaved edit');
  fireEvent.change(editor,{target:{value:'Explicit merge of first and second edits'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await waitFor(()=>expect(writes).toHaveBeenCalledTimes(2));
  expect(serverContent).toBe('Explicit merge of first and second edits');
  await screen.findByText('Draft file saved. The draft is not active.');
});

it('refreshes executable metadata after an exec-only conflict without reverting the winning edit',async()=>{
  let serverExec=false, version='a'.repeat(64);
  const content='Unchanged bytes', sha256='f'.repeat(64);
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:content.length,exec:serverExec,sha256,version,kind:'text' as const}],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${version}`});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'draftFile').mockImplementation(async()=>({id:'draft:report',path:'SKILL.md',size:content.length,content,kind:'text',truncated:false,sha256,version,exec:serverExec}));
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async()=>{
    serverExec=true;version='b'.repeat(64);throw new ApiError(409,'The draft file changed since you loaded it');
  });
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByRole('region',{name:'Draft file conflict'});
  await waitFor(()=>expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true));
  expect(writes).toHaveBeenCalledWith('report',expect.objectContaining({expectedVersion:'a'.repeat(64),exec:false}));
  expect(writes).toHaveBeenCalledTimes(1);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Use current file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Use current file'}));
  writes.mockImplementation(async(_name,body)=>{expect(body.expectedVersion).toBe('b'.repeat(64));expect(body.exec).toBe(true);return{draft:draft()};});
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await waitFor(()=>expect(writes).toHaveBeenCalledTimes(2));
  await screen.findByText('Draft file saved. The draft is not active.');
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
});

it('refreshes stale removal and requires an explicit reviewed retry preserving unsaved text',async()=>{
 let content='Original',version='a'.repeat(64),removed=false;const path='references/note.md';
 const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:4,exec:false,sha256:version,kind:'text' as const},...(removed?[]:[{path,size:content.length,exec:false,sha256:version,kind:'text' as const}])],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${version}`});
 vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
 vi.spyOn(skillsApi,'draftFile').mockImplementation(async(_name,p)=>({id:'draft:report',path:p,size:content.length,content:p===path?content:'Root',kind:'text',truncated:false,sha256:version,version,exec:false}));
 const deletes=vi.spyOn(skillsApi,'deleteDraftFile').mockImplementation(async()=>{content='Winning newer content';version='b'.repeat(64);throw new ApiError(409,'The draft file changed since you loaded it');});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
 fireEvent.click(await screen.findByRole('button',{name:/references\/note.md/}));const editor=await screen.findByRole('textbox',{name:path});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Remove file'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.change(editor,{target:{value:'Unsaved local text'}});fireEvent.click(screen.getByRole('button',{name:'Remove file'}));
 await screen.findByRole('region',{name:'Draft file conflict'});await waitFor(()=>expect((editor as HTMLTextAreaElement).value).toBe('Winning newer content'));
 expect((screen.getByRole('textbox',{name:'Your unsaved draft changes'}) as HTMLTextAreaElement).value).toBe('Unsaved local text');
 expect(deletes).toHaveBeenCalledTimes(1);expect(deletes).toHaveBeenCalledWith('report',path,'a'.repeat(64));expect(removed).toBe(false);
 expect((screen.getByRole('button',{name:'Remove file'}) as HTMLButtonElement).disabled).toBe(true);
 await waitFor(()=>expect((screen.getByRole('button',{name:'Use current file'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Use current file'}));
 deletes.mockImplementation(async(_name,_path,token)=>{expect(token).toBe('b'.repeat(64));removed=true;return{draft:draft()};});
 fireEvent.click(screen.getByRole('button',{name:'Remove file'}));await waitFor(()=>expect(deletes).toHaveBeenCalledTimes(2));expect(removed).toBe(true);
});

for (const operation of ['save','remove'] as const) for (const recovery of ['recreate','discard'] as const) it(`recovers from stale ${operation} followed by a missing file with explicit ${recovery}`, async () => {
  const path='references/note.md';
  let missing=false, content='Original note', version='a'.repeat(64), serverExec=false;
  const rootVersion='d'.repeat(64);
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:4,exec:false,sha256:rootVersion,kind:'text' as const},...(missing?[]:[{path,size:content.length,exec:serverExec,sha256:version,kind:'text' as const}])],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${version}`});
  const listing=vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'draftFile').mockImplementation(async(_name,p)=>{
    if(p===path&&missing)throw new ApiError(404,'No draft file');
    return{id:'draft:report',path:p,size:p===path?content.length:4,content:p===path?content:'Root',kind:'text',truncated:false,sha256:p===path?version:rootVersion,version:p===path?version:rootVersion,exec:p===path?serverExec:false};
  });
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async(_name,body)=>{
    if(body.expectedVersion!==null){missing=true;throw new ApiError(409,'Changed before save');}
    expect(body).toMatchObject({path,content:'Retained local note',exec:true,expectedVersion:null});
    missing=false;content=body.content;serverExec=body.exec??false;version='b'.repeat(64);return{draft:draft()};
  });
  const deletes=vi.spyOn(skillsApi,'deleteDraftFile').mockImplementation(async()=>{missing=true;throw new ApiError(409,'Changed before removal');});
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/references\/note.md/}));
  const editor=await screen.findByRole('textbox',{name:path});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(editor,{target:{value:'Retained local note'}});
  fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:operation==='save'?'Save draft file':'Remove file'}));
  await screen.findByText(/Another client removed this file/);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Recreate file with my changes'}) as HTMLButtonElement).disabled).toBe(false));
  expect(listing.mock.calls.length).toBeGreaterThan(1);
  expect(client.getQueryData<{draft:{files:{path:string}[]}}>(['skills','draft','report'])?.draft.files.some(file=>file.path===path)).toBe(false);
  expect(screen.getByRole('button',{name:/references\/note.md/}).textContent).toMatch(/not saved.*unsaved local edits/);
  expect((screen.getByRole('textbox',{name:'Your unsaved draft changes'}) as HTMLTextAreaElement).value).toBe('Retained local note');
  expect((screen.getByRole('checkbox',{name:'Your unsaved executable choice'}) as HTMLInputElement).checked).toBe(true);
  expect(writes).toHaveBeenCalledTimes(operation==='save'?1:0);
  if(recovery==='recreate') {
    fireEvent.click(screen.getByRole('button',{name:'Recreate file with my changes'}));
    await screen.findByText('Draft file saved. The draft is not active.');
    expect(missing).toBe(false);expect(content).toBe('Retained local note');expect(serverExec).toBe(true);
    expect(writes).toHaveBeenLastCalledWith('report',expect.objectContaining({expectedVersion:null,exec:true}));
  } else {
    fireEvent.click(screen.getByRole('button',{name:'Discard my local changes'}));
    await waitFor(()=>expect(screen.queryByRole('region',{name:'Draft file conflict'})).toBeNull());
    expect((await screen.findByRole('textbox',{name:'SKILL.md'}) as HTMLTextAreaElement).value).toBe('Root');
    expect(missing).toBe(true);expect(writes).toHaveBeenCalledTimes(operation==='save'?1:0);
  }
  expect(deletes).toHaveBeenCalledTimes(operation==='remove'?1:0);
});

it('retains and explicitly restores an unsaved executable choice alongside local text after conflict', async () => {
  let content='Original',version='a'.repeat(64),serverExec=false;
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:[{path:'SKILL.md',size:content.length,exec:serverExec,sha256:version,kind:'text' as const}],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${version}`});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'draftFile').mockImplementation(async()=>({id:'draft:report',path:'SKILL.md',size:content.length,content,kind:'text',truncated:false,sha256:version,version,exec:serverExec}));
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async(_name,body)=>{
    if(body.expectedVersion==='a'.repeat(64)){content='Winning server text';version='b'.repeat(64);throw new ApiError(409,'Concurrent edit');}
    expect(body).toMatchObject({content:'My local text',exec:true,expectedVersion:'b'.repeat(64)});
    content=body.content;serverExec=body.exec??false;version='c'.repeat(64);return{draft:draft()};
  });
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  const editor=await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(editor,{target:{value:'My local text'}});fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByRole('region',{name:'Draft file conflict'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Restore my text and mode to merge'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('checkbox',{name:'Your unsaved executable choice'}) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('Your unsaved executable mode: executable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Restore my text and mode to merge'}));
  expect((editor as HTMLTextAreaElement).value).toBe('My local text');
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByText('Draft file saved. The draft is not active.');expect(serverExec).toBe(true);expect(writes).toHaveBeenCalledTimes(2);
});

for (const recovery of ['recreate','discard'] as const) it(`keeps a deleted default SKILL.md conflict available for explicit ${recovery}`, async () => {
  let missing=false,content='Original instructions',version='a'.repeat(64);
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:missing?[]:[{path:'SKILL.md',size:content.length,exec:false,sha256:version,kind:'text' as const}],updatedAt:'2026-01-01T00:00:00Z',validation:{valid:!missing,errors:missing?['SKILL.md is missing']:[],warnings:[]},digest:missing?null:`sha256:${version}`});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'draftFile').mockImplementation(async()=>{
    if(missing)throw new ApiError(404,'No draft file');
    return{id:'draft:report',path:'SKILL.md',size:content.length,content,kind:'text',truncated:false,sha256:version,version,exec:false};
  });
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async(_name,body)=>{
    if(body.expectedVersion!==null){missing=true;throw new ApiError(409,'The file was removed');}
    expect(body.expectedVersion).toBeNull();content=body.content;missing=false;version='b'.repeat(64);return{draft:draft()};
  });
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  const editor=await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((screen.getByRole('button',{name:'Save draft file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(editor,{target:{value:'Retained root instructions'}});fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByText(/Another client removed this file/);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Recreate file with my changes'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('textbox',{name:'Your unsaved draft changes'}) as HTMLTextAreaElement).value).toBe('Retained root instructions');
  if(recovery==='recreate') {
    fireEvent.click(screen.getByRole('button',{name:'Recreate file with my changes'}));
    await screen.findByText('Draft file saved. The draft is not active.');expect(missing).toBe(false);expect(content).toBe('Retained root instructions');
  } else {
    fireEvent.click(screen.getByRole('button',{name:'Discard my local changes'}));
    await screen.findByText('No files yet. Add SKILL.md first.');expect(missing).toBe(true);expect(writes).toHaveBeenCalledTimes(1);
  }
});

function draftNavigationFixture() {
  const files: Record<string,{content:string;exec:boolean;version:string}> = {
    'SKILL.md':{content:'Original instructions',exec:false,version:'a'.repeat(64)},
    'references/note.md':{content:'Original note',exec:false,version:'b'.repeat(64)},
  };
  let revision=0;
  const draft=()=>({name:'report',base:{id:'private:report',digest:null},files:Object.entries(files).map(([path,file])=>({path,size:file.content.length,exec:file.exec,sha256:file.version,kind:'text' as const})),updatedAt:'2026-01-01T00:00:00Z',validation:{valid:true,errors:[],warnings:[]},digest:`sha256:${'c'.repeat(64)}`});
  vi.spyOn(skillsApi,'draft').mockImplementation(async()=>({draft:draft()}));
  vi.spyOn(skillsApi,'drafts').mockImplementation(async()=>({drafts:[draft()]}));
  vi.spyOn(skillsApi,'changes').mockResolvedValue({changes:[]});
  vi.spyOn(skillsApi,'draftFile').mockImplementation(async(_name,path)=>{
    const file=files[path];if(!file)throw new ApiError(404,'Missing file');
    return{id:'draft:report',path,size:file.content.length,content:file.content,kind:'text',truncated:false,sha256:file.version,version:file.version,exec:file.exec};
  });
  const writes=vi.spyOn(skillsApi,'writeDraftFile').mockImplementation(async(_name,body)=>{
    if(body.expectedVersion!==(files[body.path]?.version??null))throw new ApiError(409,'Changed since loaded');
    files[body.path]={content:body.content,exec:body.exec??false,version:String(++revision).padStart(64,'0')};
    return{draft:draft()};
  });
  return{files,writes};
}

it('retains independent unsaved text and executable modes across file selection with explicit save or discard',async()=>{
  const{files,writes}=draftNavigationFixture();
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});render(<QueryClientProvider client={client}><DraftEditor name="report" /></QueryClientProvider>);
  const root=await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((root as HTMLTextAreaElement).value).toBe('Original instructions'));
  fireEvent.change(root,{target:{value:'Unsaved root instructions'}});fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:/references\/note.md/}));
  const note=await screen.findByRole('textbox',{name:'references/note.md'});
  await waitFor(()=>expect((note as HTMLTextAreaElement).value).toBe('Original note'));
  fireEvent.change(note,{target:{value:'Unsaved note edit'}});fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:/^SKILL.md /}));
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'SKILL.md'}) as HTMLTextAreaElement).value).toBe('Unsaved root instructions'));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
  expect(writes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Discard unsaved changes'}));
  expect((screen.getByRole('textbox',{name:'SKILL.md'}) as HTMLTextAreaElement).value).toBe('Original instructions');
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:/references\/note.md/}));
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'references/note.md'}) as HTMLTextAreaElement).value).toBe('Unsaved note edit'));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByText('Draft file saved. The draft is not active.');
  expect(writes).toHaveBeenCalledWith('report',expect.objectContaining({path:'references/note.md',content:'Unsaved note edit',exec:true,expectedVersion:'b'.repeat(64)}));
  expect(files['SKILL.md']!.content).toBe('Original instructions');
  expect(files['references/note.md']!.content).toBe('Unsaved note edit');
  await waitFor(()=>expect(screen.queryByText(/Unsaved local edits are retained/)).toBeNull());
});

it('retains text, mode and original optimistic version when the draft editor closes and reopens',async()=>{
  const{files,writes}=draftNavigationFixture();renderAt('changes','/skills/changes');
  fireEvent.click(await screen.findByRole('button',{name:'report'}));
  const editor=await screen.findByRole('textbox',{name:'SKILL.md'});
  await waitFor(()=>expect((editor as HTMLTextAreaElement).value).toBe('Original instructions'));
  fireEvent.change(editor,{target:{value:'Locally retained edit'}});fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:'report'}));
  expect(screen.queryByRole('region',{name:'Draft report'})).toBeNull();
  files['SKILL.md']={content:'Newer remote instructions',exec:false,version:'f'.repeat(64)};
  fireEvent.click(screen.getByRole('button',{name:'report'}));
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'SKILL.md'}) as HTMLTextAreaElement).value).toBe('Locally retained edit'));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));
  await screen.findByRole('region',{name:'Draft file conflict'});
  expect(writes).toHaveBeenCalledWith('report',expect.objectContaining({content:'Locally retained edit',exec:true,expectedVersion:'a'.repeat(64)}));
  expect((screen.getByRole('textbox',{name:'Your unsaved draft changes'}) as HTMLTextAreaElement).value).toBe('Locally retained edit');
  expect((screen.getByRole('checkbox',{name:'Your unsaved executable choice'}) as HTMLInputElement).checked).toBe(true);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Use current file'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Use current file'}));
  await waitFor(()=>expect(screen.queryByText(/Unsaved local edits are retained/)).toBeNull());
  fireEvent.click(screen.getByRole('button',{name:'report'}));fireEvent.click(screen.getByRole('button',{name:'report'}));
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'SKILL.md'}) as HTMLTextAreaElement).value).toBe('Newer remote instructions'));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(false);
});

it('keeps unsaved new-file buffers visible and recoverable after switching and closing the editor',async()=>{
  const{files,writes}=draftNavigationFixture();renderAt('changes','/skills/changes');
  fireEvent.click(await screen.findByRole('button',{name:'report'}));
  await screen.findByRole('textbox',{name:'SKILL.md'});
  fireEvent.change(screen.getByRole('textbox',{name:'New file path'}),{target:{value:'references/new.md'}});
  fireEvent.click(screen.getByRole('button',{name:'Add'}));
  const editor=await screen.findByRole('textbox',{name:'references/new.md'});
  fireEvent.change(editor,{target:{value:'Never saved new file'}});fireEvent.click(screen.getByRole('checkbox',{name:'executable'}));
  fireEvent.click(screen.getByRole('button',{name:/^SKILL.md /}));
  expect(screen.getByRole('button',{name:/references\/new.md/}).textContent).toMatch(/not saved.*unsaved local edits/);
  fireEvent.click(screen.getByRole('button',{name:'report'}));fireEvent.click(screen.getByRole('button',{name:'report'}));
  fireEvent.click(await screen.findByRole('button',{name:/references\/new.md/}));
  await waitFor(()=>expect((screen.getByRole('textbox',{name:'references/new.md'}) as HTMLTextAreaElement).value).toBe('Never saved new file'));
  expect((screen.getByRole('checkbox',{name:'executable'}) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Save draft file'}));await screen.findByText('Draft file saved. The draft is not active.');
  expect(writes).toHaveBeenCalledWith('report',expect.objectContaining({path:'references/new.md',content:'Never saved new file',exec:true,expectedVersion:null}));
  expect(files['references/new.md']!.content).toBe('Never saved new file');
});
