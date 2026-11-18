/**
 * Keep the suite hermetic: it must not inherit the developer's machine settings.
 *
 * config.ts reads process.env at import, so an ambient BOARD_URL/BOARD_TOKEN
 * (present on any machine that talks to a board) silently switches the board CLI
 * from the database door to HttpBoard, and the tests then read and write a real
 * board instead of the scratch database. That is the "features.test.ts fails in
 * the full suite only" class of flake: the file is fine, the ambient environment
 * is not. Delete both before any test module imports config.
 *
 * VAULT_ROOT and DEPLOYMENT are pinned in vitest.config.ts (env), which is applied
 * before this file runs.
 */
delete process.env.BOARD_URL;
delete process.env.BOARD_TOKEN;
