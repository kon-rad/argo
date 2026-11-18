import { VaultMarkdown } from '../../components/VaultMarkdown.js';
import { SessionReferences } from '../../components/SessionReferences.js';
export { SessionReferences } from '../../components/SessionReferences.js';

export function SessionContent({ text, literal = false }: { text: string; literal?: boolean }) {
  return literal
    ? <div className="whitespace-pre-wrap break-words font-mono text-xs"><SessionReferences text={text} /></div>
    : <VaultMarkdown text={text} sessionLinks breaks className="prose max-w-none break-words text-sm [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap" />;
}
