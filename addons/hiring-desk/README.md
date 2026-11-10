# Hiring desk addon

The hiring desk is an optional product package extracted from the second-brain engine. It owns the server implementation, browser console, wire contracts, client and Arkiv packages, public site, bounded worker, ENS tooling, tests and supporting docs.

## Install in a second-brain checkout

```bash
cd app
npm install @secondbrain/hiring-desk
npm run build
secondbrain doctor
```

Then add `desk` to the vault's addon list and configure the `DESK_*` settings documented in the engine. A disabled desk does not load this package or make network connections. An enabled desk fails startup with an install command when the package is absent.

## Develop and test this package

```bash
cd addons/hiring-desk
npm ci
npm run build
npm test
```

The single `vitest.config.ts` contains server, contracts and browser projects. PostgreSQL integration tests remain opt-in through `DESK_TEST_DATABASE_URL` and `DESK_PUBLICATION_TEST_DATABASE_URL`, each restricted to a disposable `sb_*_test` database. The Python worker suite runs as part of `npm test`.

The engine host supplies database query and transaction adapters through the lifecycle hook. The package does not import engine source. Two forward-only engine migrations remain in the host because existing installations already record their migration history.
