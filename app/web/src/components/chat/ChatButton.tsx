/** The speech-bubble button at the right of the header that opens the chat panel. */
export default function ChatButton({ open, onClick, className = '' }: { open: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Ask your second brain"
      title="Ask your second brain"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-full border border-[var(--rule)] text-[var(--ink-dim)] hover:text-[var(--ink)] ${open ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : ''} ${className}`}
    >
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 5 4.6 8 8 0 0 1 13 4h0a8 8 0 0 1 8 8z" />
      </svg>
    </button>
  );
}
