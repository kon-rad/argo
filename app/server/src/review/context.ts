import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, basename, join } from 'node:path';
import { digest, type Source } from './gate.js';

const SECRET = /(?:\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|token|secret|api[_-]?key)\s*[:=]\s*["']?[^\s"',}]{6,})/gi;
export function source(ref: string, raw: unknown, essential = true, limit = 80_000): Source {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const redacted = text.replace(SECRET, match => /[:=]\s*(?:z\.|process\.env\.|secrets\.|cfg\.|config\.|\$\{|\{\{)/i.test(match) ? match : '[REDACTED]');
  return { ref, revision: digest(text), text: redacted.slice(0, limit), essential,
    missing: !text.trim(), truncated: text.length > limit, redacted:redacted !== text };
}
export function excluded(path: string, exclusions: string[]): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some(p => p.startsWith('.') || /^(?:credentials?|secrets?|CURRENT)$/i.test(p) || /\.(?:pem|key)$/i.test(p)) ||
    exclusions.some(p => path === p || path.startsWith(`${p}/`));
}
/** Explicit links within the owner's note allowlist. No crawling and no model-selected paths. */
export async function note(root: string, path: string, exclusions: string[]): Promise<Source> {
  const missing = { ref: `note:${path}`, revision: '', text: '', essential: true, missing: true, truncated: false };
  if (isAbsolute(path) || excluded(path, exclusions)) return missing;
  try {
    const base = await realpath(root), file = await realpath(resolve(base, path));
    const rel = relative(base, file);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || excluded(rel, exclusions)) return missing;
    if ((await stat(file)).size > 80_000) return { ...missing, truncated: true };
    return source(missing.ref, await readFile(file, 'utf8'));
  } catch { return missing; }
}

/** Tickets written by the card runner keep their acceptance checks in the body. */
export function hasAcceptance(ticket: Record<string,unknown>): boolean {
  const contract=ticket.contract as Record<string,unknown>|undefined;
  return !!(typeof ticket.body==='string' && ticket.body.trim() &&
    (/(?:done when|acceptance(?: criteria)?|verify|verification)\s*:/i.test(ticket.body) ||
      contract && ['verification','checks','doneWhen'].some(k=>!!contract[k])));
}
export function repositoryKey(ticket:Record<string,unknown>, registered:Record<string,unknown>): string {
  const header=typeof ticket.body==='string' ? /^Repo:\s*([a-z0-9_.-]+)\s*$/im.exec(ticket.body)?.[1] : undefined;
  const key=(header ?? String(ticket.repo ?? '')).toLowerCase();
  return Object.hasOwn(registered,key) ? key : '';
}
/** Resolve only exact registered paths or Markdown beneath owner-selected project roots. */
export async function linkedNote(root:string,link:string,registered:string[],prefixes:string[],exclusions:string[]):Promise<Source> {
  const name=link.endsWith('.md')?link:`${link}.md`;
  const missing=source(`unresolved-linked-note:${link}`,'');
  if(isAbsolute(name) || name.split(/[\\/]/).includes('..') || excluded(name,exclusions)) return missing;
  if(registered.includes(name) || prefixes.some(p=>name.startsWith(p.replace(/\/$/,'')+'/'))) return note(root,name,exclusions);
  if(name.includes('/')) return missing;
  const candidates=new Set(registered.filter(p=>basename(p)===name));
  let scanned=0,limited=false;
  const walk=async(dir:string):Promise<void>=>{
    if(++scanned>5000){limited=true;return;}
    if(excluded(dir,exclusions))return;
    let entries;try{entries=await readdir(resolve(root,dir),{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(++scanned>5000){limited=true;break;}
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile() && entry.name===name && !excluded(path,exclusions))candidates.add(path);
    }
  };
  for(const prefix of prefixes)if(!isAbsolute(prefix) && !prefix.split('/').includes('..'))await walk(prefix);
  if(limited || candidates.size!==1)return {...missing,truncated:limited};
  return note(root,[...candidates][0]!,exclusions);
}

/** Machine-session cards still retain the actual coder persona for independence checks. */
export function builderIsReviewer(ticket:Record<string,unknown>,reviewer:string,result=''):boolean {
 const body=typeof ticket.body==='string'?ticket.body:'';
 const declared=/^\s*Persona:\s*([a-z0-9_.-]+)/im.exec(body)?.[1];
 const attested=/^Builder persona:\s*([a-z0-9_.-]+)/im.exec(result)?.[1];
 return [ticket.assignee,declared,attested].some(x=>typeof x==='string' && x.toLowerCase()===reviewer.toLowerCase());
}
