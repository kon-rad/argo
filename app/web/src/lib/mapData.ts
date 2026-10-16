import { CanvasTexture, LinearFilter, Sprite, SpriteMaterial } from 'three';
import { request } from './api.js';

/**
 * Shared by both brain map views (full and kiosk): the API shapes, colours
 * and labels. Positions arrive precomputed (`secondbrain map-build` on the
 * server), so neither view runs physics.
 */

export type MapKind = 'mission' | 'goal' | 'division' | 'project' | 'feature' | 'note' | 'metric';

export interface MapNodeData {
  id: string;
  kind: MapKind;
  label: string;
  ref: string | null;
  parent: string | null;
  color: string | null;
  size: number;
  x: number;
  y: number;
  z: number;
  meta: Record<string, unknown>;
}

export interface MapEdgeData { source: string; target: string; kind: 'link' | 'belongs' | 'goal' }

export interface MapGraph { version: number; builtAt: string; nodes: MapNodeData[]; edges: MapEdgeData[] }

export interface MapMetric {
  key: string;
  label: string;
  unit: string;
  currency: string | null;
  money: boolean;
  goal: string | null;
  target: number | null;
  value: number | null;
  sampledAt: string | null;
  source: string | null;
  placeholder: boolean;
  headline: boolean;
  series: { day: string; value: number }[];
}

export interface MapNodeDetail {
  node: Omit<MapNodeData, 'x' | 'y' | 'z' | 'size'>;
  neighbours: { id: string; kind: MapKind; label: string; ref: string | null; edge: string }[];
  preview: string | null;
}

export const mapApi = {
  graph: () => request<MapGraph>('/map/graph'),
  metrics: (kiosk = false) => request<{ metrics: MapMetric[] }>(`/map/metrics${kiosk ? '?kiosk=1' : ''}`),
  node: (id: string) => request<MapNodeDetail>(`/map/node/${encodeURIComponent(id)}`),
};

/** One hue per division, picked by its slug so it stays put; notes take their division's hue. */
const DIVISION_PALETTE = ['#7c9cff', '#ff8a5c', '#56d6c2', '#b7e36b', '#ff6fb1', '#ffd166', '#9b8cff', '#4fd18b'];

export function divisionColor(slug: string): string | undefined {
  if (!slug) return undefined;
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DIVISION_PALETTE[h % DIVISION_PALETTE.length];
}

export const STAGE_COLORS: Record<string, string> = {
  idea: '#6b7280', designing: '#a78bfa', building: '#60a5fa', testing: '#fbbf24',
  live: '#34d399', parked: '#4b5563', done: '#10b981',
};

const FOLDER_COLORS: Record<string, string> = { Research: '#c7d2fe', Projects: '#94a3b8', Areas: '#64748b' };

export function nodeColor(n: MapNodeData): string {
  switch (n.kind) {
    case 'mission': return '#fff4c2';
    case 'goal': return n.label.startsWith('Y') ? '#ffe08a' : '#ffd2a6';
    case 'metric': return '#ffffff';
    case 'feature': return STAGE_COLORS[n.color ?? ''] ?? '#9ca3af';
    case 'note':
      if (n.color === 'mission') return '#fff4c2';
      return divisionColor(n.color ?? '') ?? FOLDER_COLORS[String(n.meta['folder'] ?? '')] ?? '#8b93a3';
    default: return divisionColor(n.color ?? '') ?? '#cbd5e1';
  }
}

/** 1 for a note edited today, fading to 0.35 after about four months. */
export function recency(n: MapNodeData, now = Date.now()): number {
  const t = Date.parse(String(n.meta['mtime'] ?? ''));
  if (Number.isNaN(t)) return 0.5;
  const days = Math.max(0, (now - t) / 86_400_000);
  return 0.35 + 0.65 * Math.exp(-days / 40);
}

export function formatValue(m: MapMetric): string {
  if (m.value === null) return m.placeholder ? 'not tracked yet' : 'no data';
  const v = m.unit === 'usd' ? m.value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : m.value.toLocaleString('en-US');
  return m.currency ? `${v} ${m.currency}` : `${v}${m.unit === 'hours' ? ' h' : ''}`;
}

/** Days since the last reading; the daily collector makes anything over 2 stale. */
export function ageDays(m: MapMetric, now = Date.now()): number | null {
  if (!m.sampledAt) return null;
  return Math.floor((now - Date.parse(m.sampledAt)) / 86_400_000);
}

/** The text a metric's satellite carries. Kiosk payloads have money already stripped. */
export function metricLabel(m: MapMetric): string {
  if (m.money && m.value === null && !m.placeholder) return m.label;
  const share = m.target && m.value !== null ? ` · ${((m.value / m.target) * 100).toFixed(m.value / m.target < 0.01 ? 2 : 1)}% of ${m.target.toLocaleString('en-US')}` : '';
  return `${m.label}: ${formatValue(m)}${share}`;
}

/** A text label as a camera-facing sprite. One texture per label, drawn once. */
export function labelSprite(text: string, opts: { color?: string; size?: number; bg?: boolean } = {}): Sprite {
  const font = 44;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${font}px ui-sans-serif, system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.width = w;
  canvas.height = font + 20;
  ctx.font = `600 ${font}px ui-sans-serif, system-ui, sans-serif`;
  if (opts.bg) {
    ctx.fillStyle = 'rgba(5,7,13,0.65)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = opts.color ?? '#e5e7eb';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, canvas.height / 2);
  const tex = new CanvasTexture(canvas);
  tex.minFilter = LinearFilter;
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const h = opts.size ?? 8;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  return sprite;
}

/** Anchors that carry a label in both views. Notes never do on the kiosk. */
export const LABELLED: ReadonlySet<MapKind> = new Set(['mission', 'goal', 'division', 'project', 'metric']);
