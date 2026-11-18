import {beforeEach,it,expect,vi} from 'vitest';
vi.mock('../src/review/process.js',()=>({childEnv:()=>({}),command:vi.fn(),SafeProcessError:class extends Error{}}));
import {command} from '../src/review/process.js';
import {codexReview,type HostConfig} from '../src/review/adapters.js';
import {PASS_CHARS} from '../src/review/passes.js';
import type {Snapshot} from '../src/review/gate.js';
const host={reviewer:{argv:[process.execPath],cwd:'/tmp',home:'/tmp',model:'fixture'}} as HostConfig;
const snapshot=(text:string):Snapshot=>({repo:'example/engine',pr:1,head:'a'.repeat(40),base:'b'.repeat(40),branch:'main',merged:null,checks:[],sources:[{ref:'ticket',revision:'fixture',text,essential:true,missing:false,truncated:false}]});
beforeEach(()=>{vi.mocked(command).mockReset();});
it('checks UTF-8 bytes of the actual adapter prompt before reviewer dispatch',async()=>{
 vi.mocked(command).mockResolvedValue('Logged in using ChatGPT');
 await expect(codexReview(host,'auditor',snapshot('界'.repeat(200000)),'c'.repeat(64))).rejects.toThrow(/bounded pass budget/);
 expect(command).toHaveBeenCalledTimes(1);expect(vi.mocked(command).mock.calls[0]![1]).toEqual(['login','status']);
});
it('dispatches a complete in-budget prompt with ordered history inventory and fragment metadata',async()=>{
 let prompt='';vi.mocked(command).mockImplementation(async(_exe,argv,...rest)=>{
  if(argv.includes('login'))return 'Logged in using ChatGPT';
  prompt=String(rest.at(-1));return JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{}'}})+'\n'+JSON.stringify({type:'turn.completed'});
 });
 const parts=[{ref:'source',index:1,total:2,start:0,end:50}],allHistory=['history:part-1-of-2','history:part-2-of-2'];
 await expect(codexReview(host,'auditor',snapshot('Complete evidence'),'c'.repeat(64),{index:1,total:2,files:['a.ts'],allFiles:['a.ts','b.ts'],parts,allHistory})).resolves.toEqual({});
 expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(PASS_CHARS);expect(prompt).toContain(JSON.stringify(parts));expect(prompt).toContain(JSON.stringify(allHistory));expect(prompt).toContain('Complete evidence');
});
