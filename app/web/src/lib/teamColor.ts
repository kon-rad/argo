/** A stable colour per team so an author's chip says where they sit without a legend. */
export function teamColor(team: string | null): string {
  if (!team) return 'var(--ink-dim)';
  let h = 0;
  for (const c of team) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 50% 42%)`;
}
