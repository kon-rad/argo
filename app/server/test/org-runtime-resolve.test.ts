import { expect, it } from 'vitest';
import { assignmentProblem } from '../src/org-runtime/resolve.js';
import { ProfileSchema } from '../src/org-runtime/types.js';
const p = ProfileSchema.parse({name:'Example',default:{runtime:'codex',model:'example-code',provider:null},models:{'example-code':{tier:2,canCode:true}}});
it('uses the executable compatibility rule, rather than model catalog membership', () => {
  expect(assignmentProblem({...p.default,model:'local/example'},[],p)).toMatch(/codex/);
  expect(assignmentProblem({...p.default,runtime:'zen-agent',model:'example-code'},[],p)).toMatch(/provider\/model/);
  expect(assignmentProblem({...p.default,runtime:'unknown'},[],p)).toMatch(/adapter/);
});
it('enforces coding and privileged floors and fails closed on unknown metadata', () => {
  expect(assignmentProblem(p.default,['code'],p)).toBeNull();
  for (const cap of ['review','merge','deploy']) expect(assignmentProblem(p.default,[cap],p)).toMatch(/floor/);
  expect(assignmentProblem({...p.default,model:'missing'},['code'],p)).toMatch(/floor/);
  expect(assignmentProblem(p.default,['code'],{...p,models:{'example-code':{tier:3,canCode:false}}})).toMatch(/floor/);
});
it('refuses a separate provider that the dispatch adapter cannot consume', () => {
  expect(assignmentProblem({...p.default,provider:'example'},[],p)).toMatch(/provider/);
  expect(assignmentProblem({runtime:'hermes',model:'example/model',provider:'example'},[],p)).toBeNull();
});
it('profile definitions reject arbitrary fields that might carry credentials', () => {
  expect(() => ProfileSchema.parse({...p,apiKey:'fake-test-value'})).toThrow();
  expect(() => ProfileSchema.parse({...p,default:{...p.default,token:'fake-test-value'}})).toThrow();
});
