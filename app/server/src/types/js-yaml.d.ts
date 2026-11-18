/**
 * Minimal ambient types for `js-yaml` v3 (gray-matter already brings it in). v3 ships no
 * types of its own and `@types/js-yaml` targets v4's `load`/`dump` names; this module only
 * needs the v3 `safeLoad`/`safeDump` pair the org compiler uses.
 */
declare module 'js-yaml' {
  export function safeLoad(input: string, options?: Record<string, unknown>): unknown;
  export function safeDump(input: unknown, options?: Record<string, unknown>): string;
  const yaml: { safeLoad: typeof safeLoad; safeDump: typeof safeDump };
  export default yaml;
}
