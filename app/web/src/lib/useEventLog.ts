import { useCallback, useEffect, useRef, useState } from 'react';
import type { EventPage, StreamEvent } from './api.js';

/**
 * Follows an append-only event log on agent-hub by byte offset: the first call reads from 0, every later call only
 * what was appended. Polls fast while `live` (a turn is running), slowly otherwise, and starts over when `key`
 * changes. `poke()` fetches right away (after you send a message).
 */
export function useEventLog<T extends EventPage>(
  key: string | null,
  fetchPage: (offset: number) => Promise<T>,
  live: boolean,
): { events: StreamEvent[]; last: T | null; error: Error | null; poke: () => void } {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [last, setLast] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const offset = useRef(0);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const gen = useRef(0);
  const epoch = useRef<string | undefined>(undefined);
  const busy = useRef(false);
  const again = useRef(false);

  const tick = useCallback(async (g: number): Promise<void> => {
    // One request at a time: two reads from the same offset would append the same events twice.
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    if (timer.current) clearTimeout(timer.current);
    try {
      const page = await fetchRef.current(offset.current);
      if (g !== gen.current) return;
      const rebuilt = page.epoch !== undefined && epoch.current !== undefined && page.epoch !== epoch.current;
      epoch.current = page.epoch;
      if (rebuilt && offset.current > 0) {
        // The host restarted and rebuilt the log from disk (live deltas gone, positions shifted): read it again from 0.
        offset.current = 0;
        setEvents([]);
        again.current = true;
      } else if (page.offset < offset.current) {
        // The log was replaced (shouldn't happen, but never show a spliced feed): start over.
        offset.current = 0;
        setEvents([]);
      } else if (page.events.length) {
        offset.current = page.offset;
        setEvents((prev) => prev.concat(page.events));
      }
      setLast(page);
      setError(null);
      // More already waiting (a big backlog arrives in 512 KB pages): fetch again at once.
      const more = page.offset < page.size || again.current;
      timer.current = setTimeout(() => void tick(g), more ? 0 : liveRef.current ? 1000 : 5000);
    } catch (e) {
      if (g !== gen.current) return;
      setError(e as Error);
      timer.current = setTimeout(() => void tick(g), 8000);
    } finally {
      busy.current = false;
      again.current = false;
    }
  }, []);

  useEffect(() => {
    gen.current += 1;
    busy.current = false;
    offset.current = 0;
    epoch.current = undefined;
    setEvents([]);
    setLast(null);
    setError(null);
    if (key) void tick(gen.current);
    return () => {
      gen.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, tick]);

  const poke = useCallback(() => void tick(gen.current), [tick]);
  return { events, last, error, poke };
}
