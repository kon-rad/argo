# Public desk app

Standalone browser app for the public Argo Desk marketplace. It lives outside the private operator UI and bundle, reads/writes through the `DeskClient` contract, and has no server or database dependency. It renders record fields and brief markdown with `textContent`; embedded HTML and scripts stay inert.

## Build and run

Build `@secondbrain/desk-contracts` from `app/`, then use the app workspace's Vite binary with this package's `vite.config.ts`. For local development, serve this directory with Vite and set `?endpoint=https://public-api.example` to select the public adapter origin. With no endpoint parameter, the app uses the page origin. The Vite alias points directly to the shared desk contract source to avoid changing the central workspace registry in this lane.

The page has public service cards, job cards, job posting, offer lookup and acceptance, progress/evidence inspection, and payment preparation/submission. Every posting, acceptance and payment step displays a public-data warning and asks the user to confirm the exact action. A browser wallet can be injected as `window.deskWallet` with `address()`, `publishRecord(record, idempotencyKey)` and `submit(chainId, transaction)` methods. No wallet is silently selected. Publishing checks the record's client against the wallet address; payment checks its payer and network. Payment is labeled pending until a trusted settlement adapter verifies a finalized receipt.

## Public API boundary

The app calls only `/public/*` endpoint paths from `addons/desk-client`. Operator approval, cancellation, execution trace and private job controls are absent. The backend must serve bounded public reads and validate author, finality, schema and idempotency itself. A `desk/v1` acceptance is an owner-authored public chain record; a wallet signature alone does not prove that a record executed.

The current page expects public adapter routes documented in the client README. It is not live until P2 publishes compatible handlers and P5/P6 wire identity and settlement adapters. Transaction preparation uses the shared client, while actual transaction data and supported chains remain decisions for P6.

## Arc Studio provenance

No Arc Studio payment component was produced or exported in this branch. This is an explicit provenance gap: the app's payment form is ordinary code and does not establish Arc Studio prize eligibility. Integration needs the actual Studio export, source/provenance and share URL from its producer. The lead owns dependency and bundler integration.
