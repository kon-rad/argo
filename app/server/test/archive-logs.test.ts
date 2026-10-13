import { describe, it, expect } from 'vitest';
import { splitLog } from '../src/archive/logs.js';

describe('splitLog', () => {
  const text = '2026-09-27 12:00:01,123 INFO gateway: started\n  continuation detail\n2026-09-27 12:00:05 ERROR cron: failed\npartial';

  it('parses timestamps, levels, continuation lines and absolute offsets', () => {
    const r = splitLog(Buffer.from(text), 100, null, true);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ byteOffset: 100, level: 'INFO', message: '2026-09-27 12:00:01,123 INFO gateway: started' });
    expect(r.lines[0]!.ts?.toISOString()).toBe('2026-09-27T12:00:01.123Z');
    expect(r.lines[1]!.ts?.toISOString()).toBe('2026-09-27T12:00:01.123Z');
    expect(r.lines[1]!.level).toBeNull();
    expect(r.lines[1]!.byteOffset).toBe(100 + Buffer.byteLength('2026-09-27 12:00:01,123 INFO gateway: started\n'));
    expect(r.lines[2]!.level).toBe('ERROR');
    expect(r.consumedBytes).toBe(text.lastIndexOf('\n') + 1);
    expect(r.lastTs?.toISOString()).toBe('2026-09-27T12:00:05.000Z');
  });

  it('inherits prevTs for a leading continuation line and skips empty lines', () => {
    const prev = new Date('2026-01-01T00:00:00Z');
    const r = splitLog(Buffer.from('trace\n\n'), 0, prev, true);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.ts).toEqual(prev);
  });

  it('reads naive timestamps as local time when not UTC', () => {
    const r = splitLog(Buffer.from('2026-09-27 12:00:01 INFO x\n'), 0, null, false);
    expect(r.lines[0]!.ts?.getTime()).toBe(new Date('2026-09-27T12:00:01').getTime());
  });
});
