import { config } from './config.js';
import { IN_FLIGHT, STAGES, STALE_DAYS, type Item, type ProjectView, type Report, type Stage } from './projects.js';

/** The /projects page on this install's public origin, when it has one. */
const boardUrl = (): string | null => (config.publicOrigin ? `${config.publicOrigin}/projects` : null);

/**
 * Three renderings of one report:
 *  - markdown: the full company report. The app shows it, and the nightly
 *    render writes it to the vault (`projects.reportFile`, generated, never hand-edited).
 *  - standup: the section the daily stand-up's context pack injects.
 *  - telegram: short plain text for "how are the projects?" on Telegram.
 * No em-dashes, by house style.
 */

const LABEL: Record<Stage, string> = {
  idea: 'Backlog', designing: 'Designing', building: 'Building', testing: 'Testing', live: 'Live', parked: 'Parked', done: 'Done',
};
const cell = (s: string | null | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const name = (i: Item): string => (i.feature ? `${i.project} / ${i.title}` : i.title);
const pct = (p: number | null): string => (p == null ? 'no features' : `${Math.round(p * 100)}%`);

function stageLine(counts: Record<Stage, number>): string {
  return STAGES.filter((s) => counts[s]).map((s) => `${counts[s]} ${LABEL[s].toLowerCase()}`).join(', ') || 'none';
}

function featureMix(p: ProjectView): string {
  if (!p.features.length) return 'no features yet';
  return stageLine(p.counts);
}

function list(items: Item[], empty = 'None.'): string[] {
  return items.length ? items.map((i) => `- **${name(i)}**: ${i.detail}`) : [empty];
}

export function renderMarkdown(r: Report): string {
  const g = r.gaps;
  const gapCount =
    g.goals_uncovered.length + g.unverified_shipped.length + g.failing.length + g.testing_unverified.length + g.stale.length + g.overdue.length;
  const out: string[] = [
    '# Company Report - Projects, Features, Goals',
    '### Generated from the project tracker (Postgres on the droplet). Do not edit by hand: change status with `cli-projects set`, the `/projects` page, or Telegram',
    '',
    `**Data as of:** ${r.as_of ?? 'no data'}${boardUrl() ? ` · **Live board:** ${boardUrl()}` : ''}`,
    '',
    '---',
    '',
    '## Headline',
    '',
    `- **Projects:** ${stageLine(r.totals.projects)}`,
    `- **Features:** ${stageLine(r.totals.features)}`,
    `- **Last 7 days:** ${r.moved_7d.length} stage moves, ${r.shipped_7d.length} features shipped, verifications ${r.verified_7d.pass} passed / ${r.verified_7d.fail} failed`,
    `- **Needs you:** ${r.needs_owner.length} · **Gaps:** ${gapCount}`,
    '',
    '## Needs you',
    '',
  ];
  if (r.needs_owner.length) {
    out.push('| Project / feature | What | Due |', '|---|---|---|');
    for (const n of r.needs_owner) out.push(`| ${cell(name(n))} | ${cell(n.detail)} | ${n.due ?? ''} |`);
  } else out.push('Nothing is waiting on you.');

  out.push('', '## Projects', '', '| # | Project | Division | Team | Stage | Features | Shipped | Next action | Goals |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of r.projects) {
    const health = p.health ? ` (${p.health})` : '';
    out.push(
      `| ${p.priority ?? ''} | ${p.devlog_path ? `[[${p.devlog_path.replace(/\.md$/, '')}\\|${cell(p.title)}]]` : cell(p.title)} | ${p.division ?? ''} | ${p.team ?? ''} | ${LABEL[p.stage]}${health} | ${cell(featureMix(p))} | ${pct(p.progress)} | ${cell(p.next_action ?? '')} | ${p.goals.join(', ')} |`,
    );
  }

  out.push('', '## Divisions', '');
  if (r.divisions.length) {
    out.push('| Division | Projects | Project stages | Features in flight | Shipped (7d) | Needs you |', '|---|---|---|---|---|---|');
    for (const d of r.divisions) {
      out.push(`| **${cell(d.name)}** | ${d.projects.join(', ')} | ${stageLine(d.stages)} | ${d.in_flight} | ${d.shipped_7d} | ${d.needs_owner} |`);
    }
  } else out.push('No divisions yet.');

  out.push('', '## Teams', '');
  if (r.teams.length) {
    out.push('| Team | Lead | Projects | Features in flight | Shipped (7d) |', '|---|---|---|---|---|');
    for (const t of r.teams) out.push(`| ${cell(t.name)} | ${cell(t.lead)} | ${t.projects.join(', ')} | ${t.in_flight} | ${t.shipped_7d} |`);
  } else out.push('No teams yet.');

  out.push('', '## Goals coverage', '');
  const goals = r.goals.filter((x) => !x.code.startsWith('T'));
  if (goals.length) {
    out.push('| Goal | Status | Due | Linked work |', '|---|---|---|---|');
    for (const x of goals) {
      const closed = /^(done|cancelled)/i.test(x.status);
      const linked = [...x.projects, ...x.features].join(', ') || (closed ? '' : '**nothing linked**');
      out.push(`| **${x.code}** ${cell(x.goal)} | ${cell(x.status)} | ${cell(x.due)} | ${cell(linked)} |`);
    }
  } else out.push('No goals file is set (`goalsFile` in secondbrain.json), or it was not readable.');

  out.push('', '## Gaps', '');
  out.push('**Open goals with no project or feature:**', '');
  out.push(...(g.goals_uncovered.length ? g.goals_uncovered.map((x) => `- **${x.code}** ${x.goal}`) : ['None.']));
  out.push('', '**Shipped without a passing verification:**', '', ...list(g.unverified_shipped));
  out.push('', '**Failing verification:**', '', ...list(g.failing));
  out.push('', '**In testing with no verification yet:**', '', ...list(g.testing_unverified));
  out.push('', `**Stale (in flight, no activity for ${STALE_DAYS}+ days):**`, '', ...list(g.stale));
  out.push('', '**Overdue:**', '', ...list(g.overdue));
  if (g.no_team.length) out.push('', `**No team:** ${g.no_team.join(', ')}`);
  if (g.no_division.length) out.push('', `**No division:** ${g.no_division.join(', ')}`);
  if (g.no_features.length) out.push('', `**Active projects with no features listed:** ${g.no_features.join(', ')}`);

  out.push('', '## Oldest work in flight', '', ...list(r.oldest));

  out.push('', `## Backlog (${r.backlog.total} ideas)`, '');
  out.push(...(r.backlog.by_project.length ? r.backlog.by_project.map((b) => `- **${b.project}**: ${b.count} (oldest ${b.oldest_days}d)`) : ['Empty.']));

  out.push('', '## Moved in the last 7 days', '');
  if (r.moved_7d.length) {
    out.push('| When | Item | Move | By | Note |', '|---|---|---|---|---|');
    for (const m of r.moved_7d) {
      out.push(`| ${m.at.slice(0, 10)} | ${cell(m.feature ? `${m.project} / ${m.title}` : m.title)} | ${m.from ?? 'new'} → ${m.to} | ${cell(m.by)} | ${cell(m.note)} |`);
    }
  } else out.push('Nothing moved.');

  out.push('', '## Features by project', '');
  for (const p of r.projects) {
    if (!p.features.length) continue;
    out.push(`### ${p.title}`, '', '| Feature | Stage | Days in stage | Owner | Verified |', '|---|---|---|---|---|');
    for (const f of p.features) {
      const v = f.verification ? `${f.verification.result} (${f.verification.kind}, ${f.verification.at.slice(0, 10)})` : 'no';
      out.push(`| ${cell(f.title)} | ${LABEL[f.stage]} | ${f.days_in_stage} | ${cell(f.owner)} | ${v} |`);
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** For the stand-up context pack: facts only, the agent writes the prose. */
export function renderStandup(r: Report): string {
  const g = r.gaps;
  const lines = [
    `Projects: ${stageLine(r.totals.projects)}. Features: ${stageLine(r.totals.features)}.`,
    `Last 7 days: ${r.moved_7d.length} stage moves, ${r.shipped_7d.length} shipped, verifications ${r.verified_7d.pass} pass / ${r.verified_7d.fail} fail.`,
    '',
    'Needs you:',
    ...(r.needs_owner.length ? r.needs_owner.map((n) => `- ${name(n)}: ${n.detail}${n.due ? ` (due ${n.due})` : ''}`) : ['- nothing']),
    '',
    'Divisions: projects · features in flight · needs you',
    ...r.divisions.map((d) => `- ${d.name}: ${d.projects.length} projects (${stageLine(d.stages)}) · ${d.in_flight} in flight · ${d.needs_owner} need you`),
    '',
    'Projects (priority order): stage · feature mix · next action',
    ...r.projects
      .filter((p) => !['parked', 'done'].includes(p.stage))
      .slice(0, 12)
      .map((p) => `- ${p.title}: ${LABEL[p.stage]} · ${featureMix(p)} · ${p.next_action ?? 'next action not set'}`),
    '',
    'Moved since yesterday:',
    ...(() => {
      const since = new Date(new Date(r.generated_at).getTime() - 86_400_000).toISOString();
      const m = r.moved_7d.filter((x) => x.at >= since);
      return m.length ? m.map((x) => `- ${x.feature ? `${x.project} / ${x.title}` : x.title}: ${x.from ?? 'new'} → ${x.to}${x.note ? ` (${x.note})` : ''}`) : ['- nothing'];
    })(),
    '',
    'Gaps:',
    `- goals with no linked work: ${g.goals_uncovered.map((x) => x.code).join(', ') || 'none'}`,
    `- shipped without a passing verification: ${g.unverified_shipped.map(name).join('; ') || 'none'}`,
    `- failing verification: ${g.failing.map(name).join('; ') || 'none'}`,
    `- stale: ${g.stale.map(name).join('; ') || 'none'}`,
    `- overdue: ${g.overdue.map((i) => `${name(i)} (${i.detail})`).join('; ') || 'none'}`,
  ];
  return lines.join('\n');
}

/** Plain text for Telegram: no tables, no markdown, under ~3,500 characters. */
export function renderTelegram(r: Report): string {
  const g = r.gaps;
  const inFlight = r.projects
    .filter((p) => !['parked', 'done'].includes(p.stage))
    .slice(0, 8)
    .map((p) => {
      const f = p.features.filter((x) => IN_FLIGHT.includes(x.stage)).map((x) => `${x.title} (${x.stage})`).slice(0, 3).join(', ');
      return `- ${p.title} [${p.stage}]${f ? `: ${f}` : ''}`;
    });
  const text = [
    `Projects: ${stageLine(r.totals.projects)}`,
    `Features: ${stageLine(r.totals.features)}`,
    ...(r.divisions.length ? ['', 'Divisions:', ...r.divisions.map((d) => `- ${d.name}: ${d.projects.length} projects, ${d.in_flight} in flight${d.needs_owner ? `, ${d.needs_owner} need you` : ''}`), ''] : []),
    `This week: ${r.shipped_7d.length} shipped, ${r.moved_7d.length} moves, ${r.verified_7d.pass} checks passed, ${r.verified_7d.fail} failed`,
    '',
    `Needs you (${r.needs_owner.length}):`,
    ...(r.needs_owner.length ? r.needs_owner.slice(0, 8).map((n) => `- ${name(n)}: ${n.detail}`) : ['- nothing']),
    ...(r.needs_owner.length > 8 ? [`- and ${r.needs_owner.length - 8} more on the Needs you page`] : []),
    '',
    'In flight:',
    ...inFlight,
    '',
    `Gaps: ${g.goals_uncovered.length} goals with no work (${g.goals_uncovered.map((x) => x.code).join(', ') || 'none'}), ` +
      `${g.unverified_shipped.length} shipped unverified, ${g.failing.length} failing, ${g.stale.length} stale, ${g.overdue.length} overdue`,
    '',
    ...(boardUrl() ? [`Full report: ${boardUrl()}`] : []),
  ].join('\n');
  return text.length > 3500 ? `${text.slice(0, 3480)}\n…` : text;
}
