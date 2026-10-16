import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

/**
 * Reads the note aloud with the local speech server (voice module, e.g. Kokoro).
 * The first listen renders the whole note, which takes a moment on long notes;
 * after that the server answers from its cache. The player stays visible so
 * the listener can pause, seek and change speed.
 */
export default function ListenButton({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Answers only where the voice module runs; elsewhere the route does not exist and the button stays hidden.
  const voice = useQuery({ queryKey: ['voice'], queryFn: api.voiceStatus, retry: false, staleTime: 60_000 });

  // A new note starts fresh; the old blob URL is released.
  useEffect(() => {
    setState('idle');
    setMessage(null);
    setSrc(null);
  }, [path]);
  useEffect(() => () => {
    if (src) URL.revokeObjectURL(src);
  }, [src]);

  if (voice.isError || !voice.data?.settings) return null;

  async function listen(): Promise<void> {
    setState('loading');
    setMessage(null);
    try {
      const { audio, truncated } = await api.speakNote(path);
      setSrc(URL.createObjectURL(audio));
      setState('ready');
      if (truncated) setMessage('Long note: only the first part is read.');
      // Wait a frame for the <audio> element to mount with its src.
      requestAnimationFrame(() => void audioRef.current?.play().catch(() => {}));
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      {state !== 'ready' && (
        <button
          type="button"
          onClick={() => void listen()}
          disabled={state === 'loading'}
          title={message ?? 'Read this note aloud with the local Kokoro voice'}
          className="text-[var(--accent)] hover:underline disabled:text-[var(--ink-faint)] disabled:no-underline"
        >
          {state === 'loading' ? 'Listen: rendering…' : state === 'error' ? 'Listen failed ↻' : 'Listen'}
        </button>
      )}
      {state === 'ready' && src && (
        <span className="flex w-full items-center gap-2">
          <audio ref={audioRef} src={src} controls className="h-8 min-w-0 flex-1" />
        </span>
      )}
      {message && <span className={state === 'error' ? 'text-[var(--warn)]' : ''}>{message}</span>}
    </>
  );
}
