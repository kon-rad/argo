import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { requireInput } from './artifacts.js';
import { commandRevision, registrySnapshot } from './revisions.js';
import type { Pool, PoolClient } from 'pg';
import {
  commandLease, commandRequest, commandResult, launchReceipt,
  type CommandLease, type CommandResult, type HostRegistry,
} from '@secondbrain/contracts/hosts';

export class HostServiceError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

const policyDenial = 'Host no longer qualifies for the reserved command';

async function transact<T>(pool: Pool, client: PoolClient | undefined, action: (db: PoolClient) => Promise<T>): Promise<T> {
  if (client) return action(client);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export async function revokeHost(pool: Pool, machine: string, client?: PoolClient): Promise<void> {
  await transact(pool, client, async db => {
    await db.query('LOCK TABLE hc_enroll IN SHARE ROW EXCLUSIVE MODE');
    await db.query('DELETE FROM hc_enroll WHERE machine=$1', [machine]);
    await db.query('DELETE FROM hc_tokens WHERE machine=$1', [machine]);
  });
}

// Expired attempts are retained for fenced evidence. No transition puts them
// back on the queue, even when a worker disappeared before its start receipt.
async function expireAttempts(db: Pool | PoolClient, by: 'id' | 'machine', value: string) {
  await db.query(`UPDATE hc_requests SET state='unknown',reconciled_at=coalesce(reconciled_at,now()),
    result=jsonb_build_object('attempt',attempt_id,'generation',generation,'outcome','unknown',
      'reason','Execution deadline passed without an acknowledged result')
    WHERE ${by}=$1 AND state IN ('reserved','running') AND deadline_at<=now()`, [value]);
}

export async function hostCommandStatus(db: Pool | PoolClient, id: string, caller = 'owner') {
  await expireAttempts(db, 'id', id);
  const { rows } = await db.query(`SELECT id,command,machine,state,pid,generation,result,attempt_id AS attempt,
    command_revision AS "commandRevision",registry_revision AS "registryRevision",reconciled_at AS "uncertainSince"
    FROM hc_requests WHERE id=$1 AND caller_id=$2`, [id, caller]);
  if (!rows[0]) throw new HostServiceError(404, 'Command run not found');
  return rows[0];
}

export class HostService {
  constructor(
    private readonly pool: Pool,
    private readonly registry: HostRegistry,
    private readonly client?: PoolClient,
  ) {}

  private get db() { return this.client ?? this.pool; }

  private eligibleCommands(machine: HostRegistry['machines'][number]) {
    return this.registry.commands.filter(command =>
      machine.commands.includes(command.id) &&
      (command.minRamGiB === undefined || (machine.ramGiB ?? 0) >= command.minRamGiB),
    ).map(command => command.id);
  }

  private enabled(machine: string) {
    const record = this.registry.machines.find(entry => entry.id === machine && entry.enabled);
    if (!record) throw new HostServiceError(403, 'Machine is disabled or unknown');
    return record;
  }

  async checkTransferPermission(machine: string, attempt: string, generation: number) {
    const commands = this.eligibleCommands(this.enabled(machine));
    const result = await this.db.query(`SELECT 1 FROM hc_requests WHERE attempt_id=$1 AND generation=$2 AND machine=$3
      AND command=ANY($4::text[]) AND state='reserved'`, [attempt, generation, machine, commands]);
    if (!result.rowCount) throw new HostServiceError(404, 'Input unavailable for this lease');
  }

  async issueCode(machine: string): Promise<{code: string}> {
    this.enabled(machine);
    return transact(this.pool, this.client, async db => {
      await db.query('LOCK TABLE hc_enroll IN SHARE ROW EXCLUSIVE MODE');
      const enrolled = await db.query('SELECT 1 FROM hc_tokens WHERE machine=$1', [machine]);
      if (enrolled.rowCount) throw new HostServiceError(409, 'Revoke the existing host token before enrolling again');
      const code = randomBytes(24).toString('base64url');
      await db.query(`INSERT INTO hc_enroll(code_hash,machine,expires_at) VALUES ($1,$2,now()+interval '10 minutes')
        ON CONFLICT(machine) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at`, [digest(code), machine]);
      return { code };
    });
  }

  revoke(machine: string) {
    return revokeHost(this.pool, machine, this.client);
  }

  status(id: string) {
    return hostCommandStatus(this.db, id);
  }

  async enroll(code: string): Promise<{machine: string; token: string}> {
    return transact(this.pool, this.client, async db => {
      const { rows } = await db.query<{machine: string}>(
        'DELETE FROM hc_enroll WHERE code_hash=$1 AND expires_at>now() RETURNING machine', [digest(code)]);
      if (!rows[0]) throw new HostServiceError(401, 'Invalid or expired enrollment code');
      const machine = this.enabled(rows[0].machine).id;
      const token = randomBytes(32).toString('base64url');
      await db.query('INSERT INTO hc_tokens(token_hash,machine) VALUES ($1,$2)', [digest(token), machine]);
      return { machine, token };
    });
  }

  async authenticate(token: string): Promise<string> {
    const { rows } = await this.db.query<{machine: string}>(
      'SELECT machine FROM hc_tokens WHERE token_hash=$1 FOR SHARE', [digest(token)]);
    if (!rows[0]) throw new HostServiceError(401, 'Invalid host token');
    return rows[0].machine;
  }

  async submit(input: unknown, caller = 'owner'): Promise<{id: string}> {
    const request = commandRequest.safeParse(input);
    if (!request.success) throw new HostServiceError(400, 'Invalid command request');
    const { command, requestKey, text, input: file } = request.data;
    const params = [requestKey, command, text ?? '', file ? JSON.stringify(file) : null, caller];
    const existing = async () => {
      const { rows } = await this.db.query<{id: string; matches: boolean}>(`
        SELECT id,(command=$2 AND body_text=$3 AND input_ref IS NOT DISTINCT FROM $4::jsonb) AS matches
        FROM hc_requests WHERE request_key=$1 AND caller_id=$5`, params);
      if (!rows[0]) return null;
      if (!rows[0].matches) throw new HostServiceError(409, 'Request key has a different payload');
      return { id: rows[0].id };
    };
    const replay = await existing();
    if (replay) return replay;
    const definition = this.registry.commands.find(entry => entry.id === command);
    if (!definition) throw new HostServiceError(400, 'Command is not registered');
    if (file) await requireInput(this.db, file);
    const { rows } = await this.db.query<{id: string}>(`
      INSERT INTO hc_requests(request_key,command,body_text,input_ref,caller_id,id,handler,command_revision,registry_revision,state)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'queued') ON CONFLICT(caller_id,request_key) DO NOTHING RETURNING id`,
    [...params, randomUUID(), definition.handler, commandRevision(definition), registrySnapshot(this.registry).revision]);
    return rows[0] ?? (await existing())!;
  }

  async poll(machine: string, protocol: 1 | 2 = 1): Promise<CommandLease | null> {
    const host = this.enabled(machine);
    const commands = this.eligibleCommands(host);
    if (!commands.length) return null;
    return transact(this.pool, this.client, async db => {
      // Serialise capacity checks for the same machine. Different machines can claim concurrently.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', ['hc_requests', machine]);
      await expireAttempts(db, 'machine', machine);
      const active = await db.query<{count: number}>(
        "SELECT count(*)::int AS count FROM hc_requests WHERE machine=$1 AND state IN ('reserved','running')", [machine]);
      if (active.rows[0]!.count >= host.slots) return null;
      const { rows } = await db.query(`
        WITH candidate AS (
          SELECT id FROM hc_requests WHERE state='queued' AND command=ANY($2::text[])
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
        ) UPDATE hc_requests r SET state='reserved', machine=$1,
          attempt_id=CASE WHEN $3 THEN $4 ELSE r.id END,
          deadline_at=CASE WHEN $3 THEN now()+interval '5 minutes' END FROM candidate WHERE r.id=candidate.id
        RETURNING r.id,r.attempt_id AS attempt,r.deadline_at,r.command_revision,r.registry_revision,r.generation,r.command,r.handler,r.body_text AS text,r.input_ref AS input`,
      [machine, commands, protocol === 2, randomUUID()]);
      if (!rows.length) return null;
      const { id, deadline_at, command_revision, registry_revision, ...lease } = rows[0];
      if (lease.input) delete lease.text;
      else delete lease.input;
      return commandLease.parse(protocol === 2 ? { ...lease, runId: id, deadline: deadline_at.toISOString(),
        commandRevision: command_revision ?? undefined, registryRevision: registry_revision ?? undefined } : lease);
    });
  }

  async start(machine: string, input: unknown): Promise<'started' | 'policy-denied'> {
    const receipt = launchReceipt.safeParse(input);
    if (!receipt.success) throw new HostServiceError(400, 'Invalid launch receipt');
    const { attempt, generation, pid } = receipt.data;
    return transact(this.pool, this.client, async db => {
      const { rows } = await db.query<{ state: string; expired: boolean; command_revision: string | null; pid: number | null; command: string; result: CommandResult | null }>(
        'SELECT state,pid,command,result,command_revision,(deadline_at<=now()) AS expired FROM hc_requests WHERE attempt_id=$1 AND generation=$2 AND machine=$3 FOR UPDATE',
        [attempt, generation, machine]);
      const run = rows[0];
      if (run?.expired) throw new HostServiceError(409, 'Attempt deadline has passed');
      if (run?.state === 'running' && run.pid === pid) return 'started';
      if (run?.state === 'failed' && run.pid === null && run.result?.outcome === 'failed' &&
          run.result.reason === policyDenial) return 'policy-denied';
      if (run?.state !== 'reserved') throw new HostServiceError(409, 'Launch receipt does not match the active lease');
      const host = this.registry.machines.find(entry => entry.id === machine && entry.enabled);
      const current = this.registry.commands.find(command => command.id === run.command);
      if (!host || !current || !this.eligibleCommands(host).includes(run.command) ||
          (run.command_revision !== null && run.command_revision !== commandRevision(current))) {
        const result: CommandResult = { attempt, generation, outcome: 'failed', reason: policyDenial };
        await db.query("UPDATE hc_requests SET state='failed',result=$2::jsonb WHERE attempt_id=$1", [attempt, JSON.stringify(result)]);
        return 'policy-denied';
      }
      await db.query("UPDATE hc_requests SET state='running',pid=$2 WHERE attempt_id=$1", [attempt, pid]);
      return 'started';
    });
  }

  async finish(machine: string, input: unknown): Promise<void> {
    const result = commandResult.safeParse(input);
    if (!result.success) throw new HostServiceError(400, 'Invalid command result');
    const { attempt, generation, outcome } = result.data;
    const update = await this.db.query(`UPDATE hc_requests SET state=$4,result=$5::jsonb,
      reconciled_at=CASE WHEN $4='unknown' THEN coalesce(reconciled_at,now()) ELSE reconciled_at END
      WHERE attempt_id=$1 AND generation=$2 AND machine=$3 AND (
        (state=$4 AND result=$5::jsonb) OR $4 <> 'succeeded' OR (input_ref IS NULL AND NOT ($5::jsonb ? 'output')) OR
        (input_ref IS NOT NULL AND EXISTS (SELECT 1 FROM hc_artifacts a WHERE a.run_id=hc_requests.id AND a.generation=$2
          AND a.id::text=$5::jsonb->'output'->>'id' AND a.sha256=$5::jsonb->'output'->>'sha256'
          AND octet_length(a.content)=($5::jsonb->'output'->>'bytes')::integer
          AND a.content=convert_to('{"count":' || ($5::jsonb->>'count') || '}' || chr(10),'UTF8') AND a.expires_at>now()))
      ) AND (
        state='running' OR (state='reserved' AND $4 IN ('failed','unknown'))
        OR (state='unknown' AND (pid IS NOT NULL OR $4 IN ('failed','unknown'))) OR (state=$4 AND result=$5::jsonb))`,
    [attempt, generation, machine, outcome, JSON.stringify(result.data)]);
    if (!update.rowCount) throw new HostServiceError(409, 'Result does not match the active lease');
  }
}
