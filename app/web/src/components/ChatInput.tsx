import { useLayoutEffect, useRef } from 'react';

/**
 * The message box every chat on the site uses: starts three lines tall, grows
 * with what's typed up to 40% of the screen, then scrolls. Enter sends,
 * Shift+Enter starts a new line (IME composition is left alone).
 */
export function ChatInput({ value, onChange, onSubmit, placeholder, label, disabled = false, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      rows={3}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
      className={`block max-h-[40vh] min-h-[4.5rem] min-w-0 flex-1 resize-none overflow-y-auto rounded border border-[var(--rule)] bg-[var(--paper)] px-3 py-2 text-[0.95rem] leading-snug ${className}`}
    />
  );
}
