import { useEffect, useState, type RefObject } from 'react';
import { useSearchParams } from 'react-router-dom';

interface Props {
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit(q: string): void;
}

export default function SearchBox({ inputRef, onSubmit }: Props) {
  const [params] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [value, setValue] = useState(urlQuery);

  // The URL is the source of truth: a back button, or a tag chip linking to a
  // search, has to move the box with it.
  useEffect(() => setValue(urlQuery), [urlQuery]);

  return (
    <form
      className="flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed) onSubmit(trimmed);
      }}
    >
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search the vault…  ⌘K"
        aria-label="Search the vault"
        className="w-full max-w-2xl rounded border border-[var(--rule)] bg-[var(--paper-sunk)] px-2.5 py-1 outline-none focus:border-[var(--accent)]"
      />
    </form>
  );
}
