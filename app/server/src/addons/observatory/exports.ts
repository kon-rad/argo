import { randomUUID } from 'node:crypto';
import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
import { HttpError } from '../../routes/http.js';
import type { ExportData } from './service.js';
interface Entry { owner: string; expires: number; data: ExportData; bytes: number }
/** Per-app bounded memory, no shared files or transcript cache. Tokens expire after five minutes. */
export class Exports {
  private entries = new Map<string, Entry>();
  constructor(private clock = Date.now) {}
  private prune(): void { for (const [key, value] of this.entries) if (value.expires <= this.clock()) this.entries.delete(key); }
  put(owner: string, data: ExportData): string {
    this.prune();
    const copy: ExportData = structuredClone(data);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > 4 * 1024 * 1024) throw new HttpError(413, 'export exceeds 4 MiB; narrow range');
    while (this.entries.size >= 8 || [...this.entries.values()].reduce((n, e) => n + e.bytes, 0) + bytes > 32 * 1024 * 1024) this.entries.delete(this.entries.keys().next().value!);
    const token = randomUUID(); this.entries.set(token, { owner, expires: this.clock() + 300_000, data: copy, bytes }); return token;
  }
  get(owner: string, token: string): ExportData {
    this.prune(); const entry = this.entries.get(token);
    if (!entry || entry.owner !== owner) throw new HttpError(410, 'export expired or unavailable; restart window');
    return structuredClone(entry.data);
  }
  page(owner: string, token: string, offset: number, limit: number) {
    const data = this.get(owner, token);
    if (offset > data.window.events.length) throw new HttpError(400, 'offset outside export');
    const events = data.window.events.slice(offset, offset + limit);
    return { ...data, window: { ...data.window, events }, export: token, total: data.window.events.length,
      next: offset + events.length < data.window.events.length ? offset + events.length : null, resolution: 'recorded-parts' };
  }
  event(owner: string, token: string, id: string): EvidenceEvent {
    const event = this.get(owner, token).window.events.find(e => e.id === id);
    if (!event) throw new HttpError(404, 'event absent from export'); return event;
  }
}
