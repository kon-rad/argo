import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** How close to the bottom (px) still counts as "reading the newest". */
const SLACK = 80;

/**
 * A chat's scroll box: opens at the newest message (the bottom), and stays
 * there as messages arrive or stream in, unless the reader has scrolled up to
 * read older ones. Changing `key` (another channel or chat) jumps to the
 * bottom again; a `null` key turns it off (a search result list reads from
 * the top). `pin()` jumps to the bottom, for after the reader sends.
 */
export function useStickToBottom<T extends HTMLElement = HTMLDivElement>(key: unknown) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  const toBottom = useCallback(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    pinned.current = key !== null;
    if (pinned.current) toBottom();
    else if (ref.current) ref.current.scrollTop = 0;
  }, [key, toBottom]);

  useEffect(() => {
    const el = ref.current;
    if (!el || key === null) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < SLACK;
    };
    const stick = () => {
      if (pinned.current) toBottom();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // New messages change the DOM; images and markdown settling change the size.
    const mo = new MutationObserver(stick);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    return () => {
      el.removeEventListener('scroll', onScroll);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [key, toBottom]);

  const pin = useCallback(() => {
    pinned.current = true;
    toBottom();
  }, [toBottom]);

  return { ref, pin };
}
