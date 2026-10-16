import { execFile } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { TxClient } from './db.js';

/**
 * The agent write path for inventory_items (single-database plan, Phase 6).
 * Rows are master data: there is no delete here on purpose (sb_agent has no
 * DELETE grant), and every write goes through these functions so the Telegram
 * bot, the cc-* lanes and Mac sessions all write the same shape.
 */

export class InventoryError extends Error {}

export type Db = Pick<TxClient, 'query'>;

export interface InventoryItem {
  id: number;
  name: string;
  brand: string | null;
  model: string | null;
  category: string;
  quantity: number;
  status: string;
  acquired_on: string | null;
  purchase_price: string | null;
  currency: string | null;
  location: string | null;
  notes_path: string | null;
  specs: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** acquired_on and purchase_price as text: a JS Date shifts the day in JSON, a float loses cents. */
const COLS = `id, name, brand, model, category, quantity, status, acquired_on::text AS acquired_on,
  purchase_price::text AS purchase_price, currency, location, notes_path, specs, created_at, updated_at`;

/** Vault folder for gear photos, and the B2 prefix that mirrors it (same as row 60, 2026-10-13). */
export const PHOTO_ROOT = 'Areas/inventory/photos';
export const B2_PHOTO_ROOT = 'inventory/photos';
/** Plan section 4: files over 50 MB go to B2 only, with a .b2.md stub, never into the vault. */
export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;

/** The Mac today, the droplet after Phase 5: SECONDBRAIN_DB_URL wins over the app's DATABASE_URL. */
export function resolveDbUrl(env: NodeJS.ProcessEnv, fallback: string): string {
  const override = env.SECONDBRAIN_DB_URL?.trim();
  return override ? override : fallback;
}

// ---------------------------------------------------------------- fields

export interface ItemFields {
  name?: string;
  category?: string;
  brand?: string | null;
  model?: string | null;
  location?: string | null;
  notes_path?: string | null;
  quantity?: number;
  status?: string;
  purchase_price?: string | null;
  currency?: string | null;
  acquired_on?: string | null;
  specs?: Record<string, unknown>;
}

type Kind = 'text' | 'nullable' | 'int' | 'price' | 'currency' | 'date' | 'json';
const FIELDS: Record<string, { key: keyof ItemFields; kind: Kind }> = {
  name: { key: 'name', kind: 'text' },
  category: { key: 'category', kind: 'text' },
  status: { key: 'status', kind: 'text' },
  brand: { key: 'brand', kind: 'nullable' },
  model: { key: 'model', kind: 'nullable' },
  location: { key: 'location', kind: 'nullable' },
  'notes-path': { key: 'notes_path', kind: 'nullable' },
  quantity: { key: 'quantity', kind: 'int' },
  price: { key: 'purchase_price', kind: 'price' },
  currency: { key: 'currency', kind: 'currency' },
  acquired: { key: 'acquired_on', kind: 'date' },
  specs: { key: 'specs', kind: 'json' },
};
export const FIELD_FLAGS = Object.keys(FIELDS);

/**
 * --flag value pairs → validated column values. Unknown flags are ignored here
 * (the CLI has its own: --json, --search). "none" clears a nullable column.
 */
export function fieldsFrom(opts: Record<string, string | true>): ItemFields {
  const out: ItemFields = {};
  for (const [flag, raw] of Object.entries(opts)) {
    const f = FIELDS[flag];
    if (!f) continue;
    if (raw === true) throw new InventoryError(`--${flag} needs a value`);
    const v = raw.trim();
    const clear = v === 'none';
    const set = (val: unknown) => ((out as Record<string, unknown>)[f.key] = val);
    switch (f.kind) {
      case 'text':
        if (!v || clear) throw new InventoryError(`--${flag} can't be empty`);
        set(v);
        break;
      case 'nullable':
        set(clear || !v ? null : v);
        break;
      case 'int':
        if (!/^\d+$/.test(v)) throw new InventoryError(`--${flag} must be a whole number >= 0, got "${raw}"`);
        set(Number(v));
        break;
      case 'price':
        if (clear) set(null);
        else if (!/^\d{1,8}(\.\d{1,2})?$/.test(v)) throw new InventoryError(`--price must look like 129.99, got "${raw}"`);
        else set(v);
        break;
      case 'currency':
        if (clear) set(null);
        else if (!/^[A-Za-z]{3}$/.test(v)) throw new InventoryError(`--currency must be a 3-letter code (USD, MYR, JPY), got "${raw}"`);
        else set(v.toUpperCase());
        break;
      case 'date':
        if (clear) set(null);
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))
          throw new InventoryError(`--acquired must be YYYY-MM-DD, got "${raw}"`);
        else set(v);
        break;
      case 'json': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new InventoryError(`--specs is not valid JSON: ${raw}`);
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new InventoryError('--specs must be a JSON object, e.g. \'{"fov_deg": 150}\'');
        set(parsed);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- queries

export async function listItems(db: Db, search?: string): Promise<InventoryItem[]> {
  if (search?.trim()) {
    const { rows } = await db.query<InventoryItem>(
      `SELECT ${COLS} FROM inventory_items
       WHERE concat_ws(' ', name, brand, model, category, location, notes_path) ILIKE $1
       ORDER BY category, name, id`,
      [`%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
    );
    return rows;
  }
  const { rows } = await db.query<InventoryItem>(`SELECT ${COLS} FROM inventory_items ORDER BY category, name, id`);
  return rows;
}

export async function getItem(db: Db, id: number, lock = false): Promise<InventoryItem | null> {
  const { rows } = await db.query<InventoryItem>(
    `SELECT ${COLS} FROM inventory_items WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function addItem(db: Db, f: ItemFields): Promise<InventoryItem> {
  if (!f.name) throw new InventoryError('add needs --name');
  if (!f.category) throw new InventoryError('add needs --category');
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    cols.push(k);
    vals.push(k === 'specs' ? JSON.stringify(v) : v);
  }
  const { rows } = await db.query<InventoryItem>(
    `INSERT INTO inventory_items (${cols.join(', ')})
     VALUES (${cols.map((c, i) => (c === 'specs' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})
     RETURNING ${COLS}`,
    vals,
  );
  return rows[0]!;
}

/** Sets the given columns; specs is a shallow merge (`specs || patch`), never a replace. */
export async function updateItem(db: Db, id: number, f: ItemFields): Promise<InventoryItem> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    vals.push(k === 'specs' ? JSON.stringify(v) : v);
    sets.push(k === 'specs' ? `specs = specs || $${vals.length}::jsonb` : `${k} = $${vals.length}`);
  }
  if (!sets.length) throw new InventoryError('nothing to update');
  vals.push(id);
  const { rows } = await db.query<InventoryItem>(
    `UPDATE inventory_items SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING ${COLS}`,
    vals,
  );
  if (!rows[0]) throw new InventoryError(`no inventory item ${id}`);
  return rows[0];
}

// ---------------------------------------------------------------- photos

/** lowercase kebab-case, ascii only; never empty. */
export function slugify(s: string, fallback = 'item'): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** The machine's local calendar date, YYYY-MM-DD (TZ=Asia/Tokyo on the droplet's agents). */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "<folder>" if p is Areas/inventory/photos/<folder>/<file>, else null. */
function photoFolderOf(vaultRel: string): string | null {
  const parts = vaultRel.replace(/\\/g, '/').split('/');
  const root = PHOTO_ROOT.split('/');
  if (parts.length !== root.length + 2 || root.some((r, i) => parts[i] !== r)) return null;
  return parts[root.length]!;
}

function vaultRelative(vaultRoot: string, abs: string): string | null {
  const rel = relative(vaultRoot, abs);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep) || resolve(vaultRoot, rel) !== abs) return null;
  return rel.split(sep).join('/');
}

/**
 * Which folder an item's photos go in. In order: the folder its earlier photos
 * already use; the folder the given files already sit in (photos an agent
 * dropped into the vault before a Mac session added the row); else a new
 * <date>_<slug-of-name>.
 */
export function choosePhotoFolder(item: Pick<InventoryItem, 'name' | 'specs'>, sourcesVaultRel: (string | null)[], now: Date): string {
  const existing = Array.isArray(item.specs.photos) ? item.specs.photos : [];
  for (const p of existing) {
    const f = typeof p === 'string' ? photoFolderOf(p) : null;
    if (f) return f;
  }
  const fromSources = new Set(sourcesVaultRel.map((s) => (s ? photoFolderOf(s) : null)));
  if (fromSources.size === 1) {
    const only = [...fromSources][0];
    if (only) return only;
  }
  return `${localDate(now)}_${slugify(item.name)}`;
}

/** Target file name: optional label, else the source's own name, kebab-cased; ext kept, lowercased. */
export function photoFileName(source: string, label?: string): string {
  const ext = extname(source).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const stem = label ?? basename(source, extname(source));
  return `${slugify(stem, 'photo')}${ext}`;
}

/** Adds -2, -3 … before the extension until the name is not taken. */
export function uniqueName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const n = `${stem}-${i}${ext}`;
    if (!taken(n)) return n;
  }
}

/**
 * specs.photos gets the new vault paths appended (no duplicates). specs.b2_photos
 * holds the B2 prefix: a string while the item has one folder (row 60's shape),
 * an array if photos ever span two.
 */
export function mergePhotoSpecs(
  specs: Record<string, unknown>,
  vaultPaths: string[],
  b2Prefix: string | null,
): Record<string, unknown> {
  const photos = Array.isArray(specs.photos) ? specs.photos.filter((p): p is string => typeof p === 'string') : [];
  for (const p of vaultPaths) if (!photos.includes(p)) photos.push(p);
  const next: Record<string, unknown> = { ...specs, photos };
  if (b2Prefix) {
    const cur = specs.b2_photos;
    if (typeof cur === 'string' && cur) next.b2_photos = cur === b2Prefix ? cur : [cur, b2Prefix];
    else if (Array.isArray(cur)) next.b2_photos = cur.includes(b2Prefix) ? cur : [...cur, b2Prefix];
    else next.b2_photos = b2Prefix;
  }
  return next;
}

/** B2STORE env (same as archive/collect.ts and b2-offload.sh), then PATH, then ~/.local/bin. Null if none is executable. */
export function resolveB2store(env: NodeJS.ProcessEnv): string | null {
  const isExec = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (env.B2STORE !== undefined) return env.B2STORE && isExec(env.B2STORE) ? env.B2STORE : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && isExec(join(dir, 'b2store'))) return join(dir, 'b2store');
  }
  const local = join(env.HOME ?? homedir(), '.local', 'bin', 'b2store');
  return isExec(local) ? local : null;
}

export type RunB2 = (bin: string, args: string[]) => Promise<void>;

export const runB2store: RunB2 = (bin, args) =>
  new Promise((ok, fail) => {
    execFile(bin, args, { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) fail(new Error(`${basename(bin)} ${args[0]} failed: ${String(stderr).trim().split('\n').slice(-3).join(' | ') || err.message}`));
      else ok();
    });
  });

export interface PhotoOptions {
  vaultRoot: string;
  files: string[];
  labels?: string[];
  /** Absolute path of b2store, or null to skip B2 (absent, or --no-b2). */
  b2store: string | null;
  runB2?: RunB2;
  now?: Date;
  warn?: (msg: string) => void;
}

export interface PhotoResult {
  item: InventoryItem;
  folder: string;
  vaultPaths: string[];
  b2Prefix: string | null;
  b2Uploaded: number;
  b2Errors: string[];
}

/**
 * Copies the files into the item's vault folder, uploads each with b2store,
 * then records the paths in specs. The row is checked first so a bad id
 * writes nothing; specs are merged under a row lock so two photo runs can't
 * drop each other's paths. b2_photos is only recorded when every upload of
 * this run was verified by b2store.
 */
export async function attachPhotos(
  withTx: <T>(fn: (db: Db) => Promise<T>) => Promise<T>,
  db: Db,
  id: number,
  o: PhotoOptions,
): Promise<PhotoResult> {
  const warn = o.warn ?? (() => {});
  if (!o.files.length) throw new InventoryError('photo needs at least one image path');
  if (o.labels && o.labels.length !== o.files.length)
    throw new InventoryError(`--names has ${o.labels.length} names for ${o.files.length} files`);
  const item = await getItem(db, id);
  if (!item) throw new InventoryError(`no inventory item ${id}`);

  const vaultRoot = realpathSync(resolve(o.vaultRoot));
  const sources = o.files.map((f) => {
    const abs = resolve(f);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new InventoryError(`not a file: ${f}`);
    const size = statSync(abs).size;
    if (size > MAX_PHOTO_BYTES)
      throw new InventoryError(`${f} is ${(size / 1048576).toFixed(0)} MB; files over 50 MB go to B2 only with a .b2.md stub, not into the vault`);
    return realpathSync(abs);
  });

  const folder = choosePhotoFolder(item, sources.map((s) => vaultRelative(vaultRoot, s)), o.now ?? new Date());
  const relDir = `${PHOTO_ROOT}/${folder}`;
  const absDir = join(vaultRoot, ...relDir.split('/'));
  mkdirSync(absDir, { recursive: true });

  const vaultPaths: string[] = [];
  const planned = new Set<string>();
  sources.forEach((src, i) => {
    let name: string;
    if (dirname(src) === absDir) {
      name = basename(src); // already in place (e.g. dropped there before the row existed): keep it
    } else {
      name = uniqueName(photoFileName(src, o.labels?.[i]), (n) => planned.has(n) || existsSync(join(absDir, n)));
      copyFileSync(src, join(absDir, name));
    }
    planned.add(name);
    vaultPaths.push(`${relDir}/${name}`);
  });

  const b2Sub = `${B2_PHOTO_ROOT}/${folder}`;
  let b2Uploaded = 0;
  const b2Errors: string[] = [];
  if (!o.b2store) {
    warn('warning: b2store not found (set B2STORE or put it on PATH); photos are in the vault only, specs.b2_photos not set');
  } else {
    const run = o.runB2 ?? runB2store;
    for (const p of vaultPaths) {
      try {
        await run(o.b2store, ['put', join(vaultRoot, ...p.split('/')), b2Sub]);
        b2Uploaded++;
      } catch (err) {
        b2Errors.push(`${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const e of b2Errors) warn(`warning: B2 upload failed, ${e}`);
  }
  const b2Prefix = o.b2store && b2Errors.length === 0 ? `${b2Sub}/` : null;

  const updated = await withTx(async (tx) => {
    const locked = await getItem(tx, id, true);
    if (!locked) throw new InventoryError(`no inventory item ${id}`);
    const specs = mergePhotoSpecs(locked.specs ?? {}, vaultPaths, b2Prefix);
    const { rows } = await tx.query<InventoryItem>(
      `UPDATE inventory_items SET specs = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING ${COLS}`,
      [JSON.stringify(specs), id],
    );
    return rows[0]!;
  });
  return { item: updated, folder, vaultPaths, b2Prefix, b2Uploaded, b2Errors };
}

/** One line per item for the plain list output. */
export function itemLine(i: InventoryItem): string {
  const what = [i.brand, i.model].filter(Boolean).join(' ');
  const price = i.purchase_price ? ` ${i.purchase_price}${i.currency ? ` ${i.currency}` : ''}` : '';
  const photos = Array.isArray(i.specs?.photos) ? ` photos=${i.specs.photos.length}` : '';
  return `${i.id}\t[${i.category}] ${i.name}${what ? ` (${what})` : ''}${i.quantity !== 1 ? ` x${i.quantity}` : ''}${i.status !== 'owned' ? ` ${i.status}` : ''}${i.location ? ` @${i.location}` : ''}${price}${photos}`;
}
