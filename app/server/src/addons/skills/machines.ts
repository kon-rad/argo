import type { AckRequest, HostState, ViewState } from '@secondbrain/contracts/skills';
import { query, withTransaction } from '../../db.js';

/**
 * Machine observations: what each host acknowledged, compared with what the policy wants now. A host
 * appears only from evidence: an acknowledgement, or a registered usage host that never sent one
 * (`never`, shown as unknown). An acknowledgement older than `staleAfterHours` is stale; nothing here
 * is marked synced because a Git push happened.
 */

export interface AckRow {
  host: string; agent: string; runtime: string; status: 'current' | 'dirty' | 'failed'; error: string | null; view_digest: string | null;
  policy_digest: string | null; generated_at: Date | null; received_at: Date; skills: { name: string; id: string; digest: string }[];
  missing: { skill: string; bins: string[]; env: string[] }[]; dirty: string[]; excluded?: { name: string; reason: string }[];
}

export async function recordAck(device: { id: number; host: string }, body: AckRequest): Promise<{ accepted: number; receivedAt: string }> {
  return withTransaction(async (db) => {
    const now = new Date();
    for (const v of body.views) {
      await db.query(
        `INSERT INTO skill_view_acks (host, agent, runtime, status, error, view_digest, policy_digest, generated_at, received_at, device_id, engine, skills, missing, dirty, excluded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (host, agent, runtime) DO UPDATE SET status=EXCLUDED.status, error=EXCLUDED.error, view_digest=EXCLUDED.view_digest,
           policy_digest=EXCLUDED.policy_digest, generated_at=EXCLUDED.generated_at, received_at=EXCLUDED.received_at, device_id=EXCLUDED.device_id,
           engine=EXCLUDED.engine, skills=EXCLUDED.skills, missing=EXCLUDED.missing, dirty=EXCLUDED.dirty, excluded=EXCLUDED.excluded`,
        [device.host, v.agent, v.runtime, v.status, v.error, v.viewDigest, body.policyDigest, v.generatedAt, now, device.id, body.engine,
          JSON.stringify(v.skills), JSON.stringify(v.missing), JSON.stringify(v.dirty), JSON.stringify(v.excluded ?? [])]);
    }
    await db.query(`INSERT INTO skill_ack_log (host, received_at, views, failed, dirty, policy_digest) VALUES ($1,$2,$3,$4,$5,$6)`,
      [device.host, now, body.views.length, body.views.filter((v) => v.status === 'failed').length, body.views.filter((v) => v.status === 'dirty').length, body.policyDigest]);
    await db.query(`DELETE FROM skill_ack_log WHERE host=$1 AND id NOT IN (SELECT id FROM skill_ack_log WHERE host=$1 ORDER BY received_at DESC, id DESC LIMIT 200)`, [device.host]);
    return { accepted: body.views.length, receivedAt: now.toISOString() };
  });
}

export async function readAcks(): Promise<{ acks: AckRow[]; hosts: { slug: string; display: string }[]; lastSeen: Map<string, Date> }> {
  const [acks, hosts, seen] = await Promise.all([
    query<AckRow>(`SELECT host, agent, runtime, status, error, view_digest, policy_digest, generated_at, received_at, skills, missing, dirty, excluded FROM skill_view_acks ORDER BY host, agent, runtime`),
    query<{ slug: string; display: string }>(`SELECT slug, display FROM usage_hosts ORDER BY slug`),
    query<{ host: string; at: Date }>(`SELECT host, max(received_at) AS at FROM skill_ack_log GROUP BY host`),
  ]);
  return { acks: acks.rows, hosts: hosts.rows, lastSeen: new Map(seen.rows.map((r) => [r.host, r.at])) };
}

/**
 * Hosts with desired vs observed digests. `desired(agent, runtime)` is the policy's current selection
 * (name -> digest) or null when the policy is legacy (nothing is desired, only observed).
 */
export function machineStates(
  data: Awaited<ReturnType<typeof readAcks>>, desired: (agent: string) => Map<string, string> | null, staleAfterHours: number, now = new Date(), expectedPolicyDigest?: string | null, unresolvedDesired?: (agent: string) => { name: string; reason: string }[],
): HostState[] {
  const staleMs = staleAfterHours * 3600_000;
  const out: HostState[] = [];
  const byHost = new Map<string, AckRow[]>();
  for (const a of data.acks) byHost.set(a.host, [...(byHost.get(a.host) ?? []), a]);
  const hosts = [...data.hosts];
  for (const host of byHost.keys()) if (!hosts.some((h) => h.slug === host)) hosts.push({ slug: host, display: host });
  for (const h of hosts) {
    const rows = byHost.get(h.slug) ?? [];
    if (!rows.length) { out.push({ host: h.slug, display: h.display, status: 'never', lastAck: null, views: [] }); continue; }
    const views: ViewState[] = rows.map((r) => {
      const want = desired(r.agent);
      const observed = new Map(r.skills.map((s) => [s.name, s.digest]));
      const names = [...new Set([...(want ? want.keys() : []), ...observed.keys()])].sort();
      const skills = names.map((name) => {
        const d = want ? want.get(name) ?? null : null;
        const o = observed.get(name) ?? null;
        const state = !want ? 'unknown' as const : d && o ? (d === o ? 'match' as const : 'drift' as const) : d ? 'missing' as const : 'extra' as const;
        return { name, desired: d, observed: o, state };
      });
      const excluded = [...new Map([...(r.excluded ?? []), ...(unresolvedDesired?.(r.agent) ?? [])].map(e => [e.name, e])).values()];
      const stale = now.getTime() - new Date(r.received_at).getTime() > staleMs;
      const policyDrift = want !== null && expectedPolicyDigest !== undefined && r.policy_digest !== expectedPolicyDigest;
      const drift = policyDrift || skills.some((s) => s.state === 'drift' || s.state === 'missing' || s.state === 'extra');
      const status: ViewState['status'] = excluded.length || r.status === 'failed' ? 'failed' : r.status === 'dirty' ? 'dirty' : stale ? 'stale' : drift ? 'drift' : 'current';
      return { agent: r.agent, runtime: r.runtime, viewDigest: r.view_digest, generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : null,
        receivedAt: new Date(r.received_at).toISOString(), status, error: excluded.length ? `Unresolved assignments: ${excluded.map(e => `${e.name}: ${e.reason}`).join('; ')}` : r.error ?? (policyDrift ? 'Acknowledged policy differs from the current policy; synchronize this view again.' : null), skills, missing: r.missing, dirty: r.dirty, excluded };
    });
    const last = data.lastSeen.get(h.slug) ?? rows.map((r) => new Date(r.received_at)).sort((a, b) => b.getTime() - a.getTime())[0]!;
    const rank = ['failed', 'dirty', 'stale', 'drift', 'current'] as const;
    const worst = rank.find((s) => views.some((v) => v.status === s)) ?? 'current';
    out.push({ host: h.slug, display: h.display, status: worst, lastAck: new Date(last).toISOString(), views });
  }
  return out;
}

/** "Loaded" evidence: a session summary that recorded a Skill tool call by this agent (name only; the revision is not recorded there). */
export async function loadedEvidence(days = 30): Promise<{ agent: string; skill: string; at: Date; host: string }[]> {
  try {
    const { rows } = await query<{ agent: string; skill: string; at: Date; host: string }>(
      `SELECT DISTINCT ON (profile, skill) profile AS agent, skill, coalesce(ended_at, started_at) AS at, host
         FROM agent_summaries, jsonb_array_elements_text(coalesce(touched->'skills', '[]'::jsonb)) AS skill
        WHERE profile IS NOT NULL AND coalesce(ended_at, started_at) > now() - make_interval(days => $1)
        ORDER BY profile, skill, coalesce(ended_at, started_at) DESC`, [days]);
    return rows;
  } catch {
    return [];
  }
}
