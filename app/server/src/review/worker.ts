import type pg from 'pg';
import { evidence, runReview, type Job, type Snapshot, type Source } from './gate.js';
import { GitHub, codexReview, deploy, type HostConfig } from './adapters.js';
import { note, source, linkedNote, hasAcceptance, repositoryKey, builderIsReviewer } from './context.js';
import { CapacityError, POLICY, evaluate, requireCapacity, scopeObservation } from './policy.js';

type CheckRollup = { name?: string | null; context?: string | null; status?: string | null; conclusion?: string | null; state?: string | null };
/** Preserve optional check outcomes for the reviewer; only configured required checks control readiness. */
export function normalizeChecks(checks: readonly CheckRollup[]): Snapshot['checks'] {
  const conclusions = new Map([['SUCCESS', 'pass'], ['FAILURE', 'fail'], ['SKIPPED', 'skipped'], ['NEUTRAL', 'neutral'],
    ['CANCELLED', 'fail'], ['TIMED_OUT', 'fail'], ['ACTION_REQUIRED', 'fail'], ['STARTUP_FAILURE', 'fail'], ['STALE', 'fail']]);
  const pending = new Set(['QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'PENDING']);
  const legacy = new Map([['SUCCESS', 'pass'], ['FAILURE', 'fail'], ['ERROR', 'fail'], ['PENDING', 'pending'], ['EXPECTED', 'pending']]);
  return checks.map(c => ({ name: c.name ?? c.context ?? '', state: c.status != null
    ? c.status === 'COMPLETED' ? conclusions.get(c.conclusion ?? '') ?? 'unknown' : pending.has(c.status) ? 'pending' : 'unknown'
    : legacy.get(c.state ?? '') ?? 'unknown' }));
}

export async function tick(client: pg.Client, host: HostConfig): Promise<{ claimed: boolean; job?: Job }> {
  const candidates = await client.query(`SELECT * FROM review_jobs WHERE state NOT IN ('done','rejected') AND (state<>'blocked' OR updated_at<now()-interval '5 minutes') ORDER BY CASE WHEN state='queued' THEN 0 ELSE 1 END, updated_at, id LIMIT 100`);
  for (const row of candidates.rows) {
    const job: Job = { ...row, target: host.repositories[row.repo as string]?.target ?? '' } as Job;
    const lock = `review-job:${job.id}`;
    let targetLock='';
    const acquire = async (key: string) => (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0]!.ok;
    const release = async (key: string) => { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]); };
    if (!(await acquire(lock))) continue;
    let targetHeld = false, contentHeld = false;
    try {
      // Read after claim: a preceding worker may have finished since the candidate query.
      const fresh = (await client.query('SELECT * FROM review_jobs WHERE id=$1',[job.id])).rows[0];
      Object.assign(job,fresh);
      if (job.state === 'done' || job.state === 'rejected') continue;
      const initialContext=(await client.query('SELECT review_context($1) AS context',[job.id])).rows[0]!.context;
      const repoKey=repositoryKey(initialContext.ticket,host.repositories);
      const configuredTarget = host.repositories[repoKey]?.target ?? '';
      targetLock=`review-target:${configuredTarget}`;
      const changedTarget = fresh.target && fresh.target !== configuredTarget;
      job.target = configuredTarget;
      targetHeld = await acquire(targetLock); if (!targetHeld) continue;
      const policy = (await client.query('SELECT * FROM review_policy')).rows[0];
      if (!policy?.enabled) return { claimed:false }; // disabled pauses existing submissions; never releases them
      const save = async (patch: Partial<Job>) => { await client.query('SELECT review_save($1,$2::jsonb)',[job.id,JSON.stringify(patch)]); };
      if (changedTarget) { await save({state:'blocked',error:'Registered target changed for active submission'}); return {claimed:true,job}; }
      const repo = host.repositories[repoKey];
      if (!repo || !host.targets[repo.target]) {
        await save({ state:'blocked',error:'Repository or deploy target is not registered by owner' });
        return { claimed:true,job:{...job,state:'blocked'} };
      }
      if(job.snapshot && job.snapshot.repo!==repo.github){await save({state:'blocked',error:'Repository changed for active submission'});return {claimed:true,job};}
      await save({target:job.target});
      const github = new GitHub(host,repo);
      let pinned = job.snapshot?.pr;
      if (!pinned) {
        const prev = await client.query('SELECT snapshot FROM review_jobs WHERE card=$1 AND id<$2 AND snapshot IS NOT NULL ORDER BY id DESC LIMIT 1',[job.card,job.id]);
        pinned = (prev.rows[0]?.snapshot as Snapshot | undefined)?.pr;
      }
      const gather = async (): Promise<Snapshot> => {
        const context = (await client.query('SELECT review_context($1) AS context',[job.id])).rows[0]!.context as Record<string,unknown>;
        const sources: Source[] = Object.entries(context).map(([key,value]) => ({ ...source(`board:${job.card}:${key}`,value),truncated:Array.isArray(value) && (value.length>100 || value.some(v=>v && typeof v==='object' && v.truncated===true)) }));
        // Empty collections are valid, absent ticket/body/acceptance or builder evidence is not.
        const ticket = context.ticket as Record<string,unknown>;
        if (!hasAcceptance(ticket)) sources.push(source('missing:ticket-acceptance',''));
        for (const path of repo.notes) sources.push(await note(host.notesRoot,path,host.exclude));
        const text = JSON.stringify([context.ticket,context.comments]);
        const conversations=context.conversations as {id:number;thread_id:number|null}[];
        for(const match of text.matchAll(/org-thread:(\d+)/g)) {
          const id=Number(match[1]);
          if(!conversations.some(m=>m.id===id || m.thread_id===id)) sources.push(source(`missing:org-thread:${id}`,''));
        }
        const links = [...text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(m => m[1]!);
        if (links.length > 20) sources.push({ ...source('linked-notes',''),truncated:true });
        for (const path of [...new Set(links)].slice(0,20)) {
          sources.push(await linkedNote(host.notesRoot,path,repo.notes,repo.noteRoots ?? [],host.exclude));
        }
        // Host materializes run files under a fixed card directory, never follows a PR-provided path.
        sources.push(await note(host.evidenceRoot,`${job.card}/RESULT.md`,host.exclude));
        sources.push(await note(host.evidenceRoot,`${job.card}/run.log`,host.exclude));
        if(builderIsReviewer(ticket,job.reviewer,sources.find(s=>s.ref.endsWith('/RESULT.md'))?.text))throw new Error('Independent review required: the reviewer authored this work');
        const p = await github.pr(job.card,pinned);
        pinned = p.number;
        if(sources.filter(s=>s.ref.startsWith('note:'+job.card+'/')).some(s=>!s.text.startsWith('Builder revision: '+p.headRefOid+'\n')))sources.push(source('missing:evidence-for-current-head',''));
        const threads=await github.threads(p.number);
        sources.push(source(`github:${repo.github}/pull/${p.number}`,{body:p.body,headRefName:p.headRefName,baseRefName:p.baseRefName,isDraft:p.isDraft,reviewDecision:p.reviewDecision,statusCheckRollup:p.statusCheckRollup,threads}));
        // After merge, retain the approved base even if the protected branch has advanced.
        const revision={...p,baseRefOid:p.mergeCommit && job.snapshot ? job.snapshot.base : p.baseRefOid};
        const snapshot=(preflight?:Snapshot['preflight']):Snapshot=>({ repo:repo.github,pr:p.number,head:p.headRefOid,behind:p.state==='OPEN' && p.mergeStateStatus==='BEHIND',conflicting:p.state==='OPEN' && (p.mergeStateStatus==='DIRTY' || p.mergeable==='CONFLICTING'),draft:p.isDraft,unresolved:threads.filter(t=>!t.isResolved).length,changesRequested:p.reviewDecision==='CHANGES_REQUESTED',
          base:revision.baseRefOid,branch:p.baseRefName,merged:p.mergeCommit?.oid ?? null,
          requiredChecks:[...repo.checks],checks:normalizeChecks(p.statusCheckRollup),sources,...(preflight?{preflight}:{}) });
        try{
          const diff=await github.diff(revision), code=await github.code(revision);
          const current=await github.pr(job.card,p.number);
          if(current.headRefOid!==p.headRefOid || current.baseRefOid!==p.baseRefOid)throw new Error('PR head or base changed during collection; retry with fresh evidence');
          requireCapacity(evaluate(scopeObservation([],code,diff,0,sources.reduce((n,s)=>n+s.text.length,0)),'actual'));
          sources.push(source(`github:diff:${p.headRefOid}`,diff,true,POLICY.diffChars));for(const item of code)sources.push(source(item.ref,item.text));return snapshot();
        }catch(error){
          if(!(error instanceof CapacityError))throw error;
          const mapping:Record<string,string>={changedFiles:'scope-changed-files',reviewableFiles:'scope-reviewable-files',sources:'scope-sources',sourceChars:'scope-source-chars',diffChars:'scope-diff-chars',combinedChars:'scope-combined-chars'};
          return snapshot(error.result.reasons.filter(r=>mapping[r.code]).map(r=>({code:mapping[r.code] as 'scope-changed-files',severity:'high' as const,location:'Review source capacity',evidence:`Observed ${r.observed}; allowed ${r.allowed}. Full independent model review did not run.`,impact:'This revision exceeds the deterministic reviewer capacity and is not accepted.',fix:r.action,verification:'Run review scope actual on the complete clean revision and record a passing result.'})));
        }

      };
      await runReview(job,repo.checks,{
        gather,
        beforeShip:async()=>{if(!contentHeld){contentHeld=await acquire(`review-content:${job.card}`);if(!contentHeld)throw new Error('Ticket evidence is changing; retry shipping');}},
        verifyMerge:(s,revision)=>github.confirmMerge(job.card,s,revision),
        mayShip:async()=>{const p=(await client.query('SELECT * FROM review_policy')).rows[0];return p?.enabled===true && p.shipping_enabled===true;},
        review:(s,e) => codexReview(host,job.reviewer,s,e),save,
        reject:async text => { await github.reject(job.snapshot!.pr,job.id,text); },
        merge:s => github.merge(job.card,s),
        deploy:async revision => {
          if (!(await deploy(host,job.target,'deploy',revision,String(job.id)))) throw new Error('Deployment health failed');
          return revision;
        },
        health:revision => deploy(host,job.target,'health',revision,String(job.id)),
        complete:async () => {
          // Ticket and evidence can change during deployment too. Keep actual shipping receipts if so.
          const current = await gather();
          if (evidence(current) !== evidence(job.snapshot!)) throw new Error('Ticket or evidence changed after merge; owner reconciliation required');
          await client.query('SELECT review_complete($1)',[job.id]);
        },
      });
      return { claimed:true,job };
    } finally {
      if (targetHeld) await release(targetLock);
      if (contentHeld) await release(`review-content:${job.card}`);
      await release(lock);
    }
  }
  return { claimed:false };
}
