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
  stub(url=>url.includes('/drafts')?json({drafts:[]}):json({changes:[{id:'fixture',kind:'update',skill:'report',status:'live',createdAt:'2026-01-01T00:00:00Z',preview:{summary:'Update report'}}]}));
  renderAt('changes','/skills/changes');
  expect(await screen.findByText('catalog matches; check machine sync')).toBeTruthy();
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
  await waitFor(()=>expect((screen.getByRole('button',{name:'Restore my text to merge'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Restore my text to merge'}));
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
