import { parseRecord, type Acceptance, type Job, type Observation, type Provider } from '@secondbrain/desk-contracts/desk';
import { PublicHttpDeskClient, postWithWallet, acceptWithWallet, submitPreparedTransaction } from '../../desk-client/src/client.mjs';
import './style.css';

declare global { interface Window { deskWallet?: { address(): Promise<string>; publishRecord(record: unknown, idempotencyKey: string): Promise<{status:'pending'|'confirmed'|'failed'; ref?:string}>; submit(chainId: string, transaction: unknown): Promise<{hash:string}> } } }
const root = document.querySelector<HTMLDivElement>('#app')!;
const endpoint = new URLSearchParams(location.search).get('endpoint') ?? location.origin;
const client = new PublicHttpDeskClient(endpoint);
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
const panel = (title: string) => { const section = el('section'); section.append(el('h2', title)); return section; };
const output = el('pre', 'Connect to a public desk endpoint to load marketplace data.');
const warn = el('aside', 'PUBLIC NETWORK: submissions, wallet addresses, briefs, offer terms, payment transactions and delivery references are visible to anyone. Review the exact action before continuing.');
warn.className = 'warning';
const shell = el('main');
const header = el('header');
const hero = el('div');
header.append(hero); shell.append(header);
hero.append(el('p', 'ARGO · OPEN WORK MARKET'), el('h1', 'A public desk for useful work'), el('p', 'Browse providers, publish a brief, review terms and verify delivery evidence.'), warn);
const cards = panel('Services and public job board');
const refresh = el('button', 'Refresh public data');
const list = el('div'); list.className = 'cards';
cards.append(refresh, list);
const posting = panel('Post a job');
const jobForm = el('form');
const fields: Record<string, HTMLInputElement> = {};
for (const [name, placeholder] of Object.entries({ chainId: 'Public chain id (namespace:id)', client: 'Wallet address', skill: 'Skill requested', brief: 'Brief (public)', budgetAtomic: 'Budget in atomic units', asset: 'Asset identifier', paymentChainId: 'Payment chain id', deadline: 'Deadline (Unix seconds)' })) {
  const input = el(name === 'brief' ? 'textarea' as keyof HTMLElementTagNameMap : 'input' as keyof HTMLElementTagNameMap) as HTMLInputElement;
  input.name = name; input.placeholder = placeholder; input.required = true; fields[name] = input; jobForm.append(input);
}
const postButton = el('button', 'Review and publish public job'); postButton.type = 'submit'; jobForm.append(postButton); posting.append(jobForm);
const review = panel('Offer review and acceptance');
const refInput = el('input'); refInput.placeholder = 'Job entity reference'; refInput.setAttribute('aria-label', refInput.placeholder);
const loadOffers = el('button', 'Load offers');
const offers = el('div');
const acceptance = el('textarea'); acceptance.placeholder = 'Acceptance JSON using desk/v1 fields'; acceptance.setAttribute('aria-label', acceptance.placeholder);
const acceptButton = el('button', 'Review exact acceptance and submit');
review.append(refInput, loadOffers, offers, acceptance, acceptButton);
const progress = panel('Progress, released result and evidence');
const inspectRef = el('input'); inspectRef.placeholder = 'Job entity reference';
const inspectButton = el('button', 'Inspect public state');
progress.append(inspectRef, inspectButton);
const payment = panel('Prepare payment');
const paymentJson = el('textarea'); paymentJson.placeholder = 'Accepted PaymentIntent JSON';
const paymentButton = el('button', 'Prepare exact payment');
payment.append(paymentJson, paymentButton);
shell.append(cards, posting, review, progress, payment, output, el('footer', 'Public evidence is independently verifiable only when a complete finalized chain read is available.'));
root.append(shell);

function show(value: unknown) { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function showResult(result: any) { if (result.kind === 'ok') show(result.value); else show(`${result.kind}: ${result.message}`); }
function entityRef(o: Observation) { return o.ref; }
async function refreshBoard() {
  list.replaceChildren(); show('Loading public marketplace…');
  const discovered = await client.discover();
  if (discovered.kind !== 'ok') { showResult(discovered); return; }
  const services: Provider[] = [], jobs: Array<{ref:string; record:Job}> = [];
  for (const observation of discovered.value) {
    try { const record = parseRecord(observation.record); if (record.type === 'provider') services.push(record); if (record.type === 'job') jobs.push({ ref: entityRef(observation), record }); } catch { /* malformed public data is omitted and reported below */ }
  }
  for (const provider of services) { const card = el('article'); card.append(el('h3', provider.skill), el('p', `Provider ${provider.providerId} · version ${provider.skillVersion}`), el('p', `Public profile: ${provider.profileRef}`)); list.append(card); }
  for (const job of jobs) { const card = el('article'); card.append(el('h3', job.record.skill), el('p', job.record.brief), el('p', `Budget: ${job.record.budgetAtomic} atomic · deadline ${job.record.deadline}`), el('code', job.ref)); list.append(card); }
  if (!list.childElementCount) list.append(el('p', 'No public services or jobs were returned.'));
  show(`Loaded ${services.length} services and ${jobs.length} jobs from the public endpoint. Invalid rows were skipped.`);
}
refresh.addEventListener('click', () => void refreshBoard());
jobForm.addEventListener('submit', async event => {
  event.preventDefault();
  const job = { version: 'desk/v1', domain: 'desk/v1', chainId: fields.chainId.value.trim(), type: 'job', jobId: crypto.randomUUID(), nonce: crypto.randomUUID(), client: fields.client.value.trim(), skill: fields.skill.value.trim(), brief: fields.brief.value, budgetAtomic: fields.budgetAtomic.value.trim(), asset: fields.asset.value.trim(), paymentChainId: fields.paymentChainId.value.trim(), deadline: Number(fields.deadline.value) };
  try { const checked = parseRecord(job) as Job; show({ action: 'Publish this public job', publicWarning: warn.textContent, record: checked }); if (!confirm('This exact brief, wallet address and terms will be sent to a public network. Continue?')) return; if (!window.deskWallet) return show('Connect an injected wallet with public record publishing enabled. Nothing was sent.'); const result = await postWithWallet(window.deskWallet, checked, crypto.randomUUID()); showResult(result); } catch (error) { show(`Invalid job: ${error instanceof Error ? error.message : String(error)}`); }
});
loadOffers.addEventListener('click', async () => { if (!refInput.value.trim()) return show('Enter a job reference first.'); const result = await client.offers(refInput.value.trim()); showResult(result); offers.textContent = result.kind === 'ok' ? JSON.stringify(result.value, null, 2) : result.message; });
acceptButton.addEventListener('click', async () => {
  try {
    const record = parseRecord(JSON.parse(acceptance.value)) as Acceptance;
    if (record.type !== 'acceptance') throw new Error('Expected an acceptance record.');
    show({ action: 'Publish this acceptance', publicWarning: warn.textContent, record });
    if (!confirm('Acceptance and wallet address are public and bind the displayed offer terms. Continue?')) return;
    if (!window.deskWallet) return show('Connect an injected wallet with public record publishing enabled. Nothing was sent.');
    showResult(await acceptWithWallet(window.deskWallet, record, crypto.randomUUID()));
  } catch (error) { show(`Acceptance not submitted: ${error instanceof Error ? error.message : String(error)}`); }
});
inspectButton.addEventListener('click', async () => { try { const ref = inspectRef.value.trim(); const state = await client.inspect(ref); const evidence = await client.independentRead(ref); show({ state, evidence }); } catch (error) { show(`Public read failed: ${error instanceof Error ? error.message : String(error)}`); } });
paymentButton.addEventListener('click', async () => {
  try {
    const intent = JSON.parse(paymentJson.value);
    show({ action: 'Prepare payment transaction', publicWarning: warn.textContent, intent });
    if (!confirm('Payment intent and transaction preparation are public. Continue?')) return;
    const prepared = await client.preparePayment(intent);
    if (prepared.kind !== 'ok') return showResult(prepared);
    show({ prepared: prepared.value, note: 'Review the exact transaction above. No payment is confirmed until the chain verifier confirms a finalized receipt.' });
    if (!window.deskWallet) return show('Transaction prepared. Inject an authorized wallet to submit it. No payment was sent.');
    if (!confirm('Submit this exact prepared transaction with the connected wallet?')) return show('Transaction prepared; wallet submission cancelled.');
    showResult(await submitPreparedTransaction(window.deskWallet, intent, prepared.value));
  }
  catch (error) { show(`Payment not prepared: ${error instanceof Error ? error.message : String(error)}`); }
});
void refreshBoard();
