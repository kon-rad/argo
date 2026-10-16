import { settings, type MetricSetting } from '../settings.js';

/**
 * Every number the brain map shows, from the `metrics` list in the vault's
 * secondbrain.json (none by default). Collected metrics get rows in
 * metric_samples from `cli-metrics collect` (daily) or `cli-metrics set`;
 * derived ones (`sum`, `derived`) are computed when the page asks. Targets
 * come from the owner's own goals, never invented here.
 */

export type MetricDef = MetricSetting;

export function metrics(): readonly MetricDef[] {
  return settings().metrics;
}

export function metricDef(key: string): MetricDef | undefined {
  return metrics().find((m) => m.key === key);
}
