import { runReview, type Job, type Snapshot, type Verdict } from './gate.js';
/** No network, credentials, database or filesystem writes. */
export async function runFixture(): Promise<unknown> {
  const traces: unknown[] = [];
  for (const reject of [true,false]) {
    const head = 'a'.repeat(40), base = 'b'.repeat(40), revision = 'c'.repeat(40);
    const job: Job = {id:1,card:'t_123abc',builder:'builder',reviewer:'auditor',target:'fixture',round:0,state:'queued',snapshot:null,verdict:null,merged:null,deployed:null};
    const events: string[] = [];
    const checked = () => ({status:'checked' as const,evidence:['fixture:ticket'],rationale:'Fixture acceptance and verification evidence'});
    const snapshot: Snapshot = {repo:'example/engine',pr:1,head,base,branch:'main',merged:null,checks:[{name:'tests',state:'pass'}],sources:[{ref:'fixture:ticket',revision:'1',text:'Acceptance checks and test evidence',essential:true,missing:false,truncated:false}]};
    await runReview(job,['tests'],{
      gather:async () => snapshot,
      review:async (_,evidence): Promise<Verdict> => ({decision:reject?'reject':'accept',reviewer:'auditor',repo:snapshot.repo,pr:1,head,base,evidence,
        categories:{security:checked(),compatibility:checked(),migrations:checked(),regressions:checked(),scope:checked(),placeholders:checked(),tests:checked()},
        findings:reject?[{severity:'high',location:'example.ts:1',evidence:'Missing authorization',impact:'Unauthorized write',fix:'Check caller',verification:'Add denial test'}]:[]}),
      save:async patch => { Object.assign(job,patch); if(patch.state) events.push(patch.state); },
      reject:async text => { events.push(`builder-send-back: ${text}`); },
      merge:async () => { events.push(`merge-exact:${head}`);return revision; },
      deploy:async sha => { events.push(`deploy:${sha}`);return sha; },
      health:async sha => { events.push(`health:${sha}`);return true; },
      complete:async () => { events.push('release-dependencies'); },
    });
    traces.push({scenario:reject?'reject':'accept',state:job.state,events});
  }
  return traces;
}
