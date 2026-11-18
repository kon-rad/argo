/** Explicit test authority for reconciliation fixtures; never imported by application code. */
import { markPolicyReviewed } from '../../src/addons/skills/policy-review.js';
import { authorizeRemotePlan, planFingerprint, planViews, type Plan } from '../../src/addons/skills/reconcile.js';

export function reviewedPlanViews(...args: Parameters<typeof planViews>): Plan {
  const policy=args[1];
  if(policy.valid && policy.mode==='managed' && policy.exists) markPolicyReviewed(policy,{
    repo:'fixture-org/fixture-vault',path:'.agents/skills-policy.yaml',revision:'a'.repeat(40),digest:policy.digest!,source:'test-fixture',approvedBy:'fixture-owner',
  });
  return planViews(...args);
}

/** A fake trusted server returns the fixture's canonical plan fingerprint, without making a network call. */
export const fixtureAuthorizationFetch: typeof fetch = async (input,init) => {
  if(String(input)!=='https://skills.test/api/skills/authorize') throw new Error(`Unexpected fixture authority URL: ${input}`);
  if(!new Headers(init?.headers).get('Authorization')) throw new Error('Fixture authority requires device authentication');
  const body=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({policyDigest:body.policyDigest,fingerprint:body.fingerprint}),{headers:{'content-type':'application/json'}});
};
export async function authorizeFixturePlan(plan: Plan): Promise<Plan> {
  await authorizeRemotePlan(plan,'https://skills.test','fixture-token',async()=>new Response(JSON.stringify({policyDigest:plan.policyDigest,fingerprint:planFingerprint(plan)}),{headers:{'content-type':'application/json'}}));
  return plan;
}
