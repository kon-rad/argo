import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, EMPTY_RULES, isSecretPath, shellWords, toolPayload, type LocalRules } from '../src/guard.js';

/** The engine's harness/hooks/test_guard.py cases, replayed against the port. */
const SHELL: [string, boolean][] = [
  ['cat .env', true],
  ['cat ~/.hermes/.env | head', true],
  ['grep API_KEY .env', true],
  ['tail -n 3 /srv/vault/.env.production', true],
  ['cp .env /tmp/x', true],
  ['cat .env.example', false],
  ['set -a; . ./.env; set +a; python3 gen.py | head -5', false],
  ['source .env && echo ok', false],
  ['rsync -avz --delete web/ server:/srv/web/', true],
  ['rsync -avzn --delete web/ server:/srv/web/', false],
  ['rsync -avz --delete --dry-run web/ server:/srv/web/', false],
  ['rsync -avz web/ server:/srv/web/', false],
  ['git push --force origin main', true],
  ['git push -f', true],
  ['git push --force-with-lease', true],
  ['git push origin +main', true],
  ['git push origin main', false],
  ["git commit -m 'fix -f flag docs' && git push", false],
  ['echo $(cat .env)', true],
  ['ls /home/someone', false],
  ["rsync -azn --delete --exclude node_modules --exclude '.env.local' ./ srv:/app/", false],
  ["rsync -az --exclude=.env --filter='protect .env.production' ./ srv:/app/", false],
  ['rsync -az --exclude node_modules .env.local srv:/app/', true],
  ["rsync -az --exclude '.env.local' ./.env srv:/app/", true],
];

const FILES: [string, string, boolean][] = [
  ['Read', '/vault/.env', true],
  ['Read', '.env.local', true],
  ['Read', '.env.example', false],
  ['Read', '/home/agent/.hermes/auth.json', true],
  ['Read', '/home/agent/.claude/.credentials.json', true],
  ['Edit', '.env', true],
  ['Write', 'Projects/x/notes.md', false],
  ['Grep', '.env', true],
];

const LOCAL: LocalRules = {
  protected_dirs: [{ path: '/home/signer/', reason: 'the signer\'s keys' }],
  no_delete: [{ path: 'media/blob', reason: 'blobs are irreplaceable' }],
  readonly: [{ pattern: 'Areas/legacy/[^/]*\\.html$', reason: 'legacy page' }],
  disable: new Set(),
};

test('built-in shell rules match the Python guard', () => {
  for (const [cmd, blocked] of SHELL) {
    const reason = decide({ tool_name: 'Bash', tool_input: { command: cmd } }, EMPTY_RULES);
    assert.equal(Boolean(reason), blocked, `${cmd} → ${reason}`);
    if (reason) assert.match(reason, /^guard: /);
  }
});

test('secrets files are blocked for file tools in both naming schemes', () => {
  for (const [tool, path, blocked] of FILES) {
    assert.equal(Boolean(decide({ tool_name: tool, tool_input: { file_path: path } }, EMPTY_RULES)), blocked, `${tool} ${path}`);
  }
  assert.ok(decide({ tool_name: 'read_file', tool_input: { path: '.env' } }, EMPTY_RULES));
  assert.ok(decide({ tool_name: 'write_file', tool_input: { path: 'x/.env.prod' } }, EMPTY_RULES));
  assert.equal(decide({ tool_name: 'write_file', tool_input: { path: 'x/.env.example' } }, EMPTY_RULES), null);
});

test('local rules: protected dirs, no_delete, readonly', () => {
  const shell: [string, boolean][] = [
    ['ls /home/signer/', true],
    ['sudo cat /home/signer/key.json', true],
    ['rm -rf ~/app/media/blob/abc', true],
    ["find ~/app/media/blob -name '*.tmp' -delete", true],
    ['ls ~/app/media/blob', false],
    ['rm -rf /tmp/other', false],
  ];
  for (const [cmd, blocked] of shell) assert.equal(Boolean(decide({ tool_name: 'Bash', tool_input: { command: cmd } }, LOCAL)), blocked, cmd);
  const files: [string, string, boolean][] = [
    ['Write', 'Areas/legacy/old-page.html', true],
    ['Read', 'Areas/legacy/old-page.html', false],
    ['Read', '/home/signer/.config/key', true],
    ['Write', 'Areas/legacy/notes.md', false],
  ];
  for (const [tool, path, blocked] of files) assert.equal(Boolean(decide({ tool_name: tool, tool_input: { file_path: path } }, LOCAL)), blocked, `${tool} ${path}`);
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'ls /home/signer/' } }, LOCAL)!, /signer's keys/);
});

test('rsync_dry_run can be disabled; nothing else can', () => {
  const rules: LocalRules = { ...EMPTY_RULES, disable: new Set(['rsync_dry_run']) };
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'rsync -avz --delete a/ b/' } }, rules), null);
  assert.ok(decide({ tool_name: 'Bash', tool_input: { command: 'cat .env' } }, rules));
});

test('unknown tools and unreadable payloads are allowed (fail open)', () => {
  assert.equal(decide({ tool_name: 'search_notes', tool_input: { query: '.env' } }, EMPTY_RULES), null);
  assert.equal(decide({ tool_name: 'Bash', tool_input: 'cat .env' as unknown as Record<string, unknown> }, EMPTY_RULES), null);
  assert.equal(decide({}, EMPTY_RULES), null);
});

test('zen tool calls map to the Claude Code payload', () => {
  assert.deepEqual(toolPayload('bash', { command: 'ls' }, '/w'), { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' });
  assert.equal(toolPayload('read_file', { path: '.env' }, '/w')!.tool_input!['file_path'], '.env');
  assert.equal(toolPayload('edit_file', { path: 'a', old: 'x', new: 'y' }, '/w')!.tool_name, 'Edit');
  assert.equal(toolPayload('card_show', { id: 't_1' }, '/w'), null);
});

test('helpers', () => {
  assert.deepEqual(shellWords(`FOO=1 sudo cat "a b" 'c d' e\\ f`), ['FOO=1', 'sudo', 'cat', 'a b', 'c d', 'e f']);
  assert.ok(isSecretPath('/x/.env.local'));
  assert.ok(!isSecretPath('/x/.env.example'));
  assert.ok(isSecretPath('auth.json'));
});
