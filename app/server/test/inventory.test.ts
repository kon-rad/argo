import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli-projects.js';
import { query, withTransaction } from '../src/db.js';
import {
  addItem,
  attachPhotos,
  choosePhotoFolder,
  type Db,
  fieldsFrom,
  getItem,
  InventoryError,
  listItems,
  mergePhotoSpecs,
  photoFileName,
  resolveB2store,
  resolveDbUrl,
  slugify,
  uniqueName,
  updateItem,
} from '../src/inventory.js';

const db: Db = { query };
const withTx = <T>(fn: (tx: Db) => Promise<T>) => withTransaction(fn);
const NOW = new Date(2026, 9, 14, 9, 30); // local 2026-10-14

beforeAll(async () => {
  // These tests TRUNCATE inventory_items: refuse to run anywhere but a *_test database.
  const { rows } = await query<{ db: string }>('SELECT current_database() AS db');
  expect(rows[0]!.db).toMatch(/_test$/);
});

beforeEach(async () => {
  await query('TRUNCATE inventory_items RESTART IDENTITY');
});

const opts = (...argv: string[]) => parseArgs(argv).opts;

describe('fieldsFrom', () => {
  it('maps flags to columns and validates them', () => {
    expect(
      fieldsFrom(opts('--name', 'CUSFLYX cam', '--category', 'camera', '--notes-path', 'Areas/x.md', '--quantity', '2',
        '--price', '12.50', '--currency', 'jpy', '--acquired', '2026-10-13', '--specs', '{"fov_deg":150}', '--json')),
    ).toEqual({
      name: 'CUSFLYX cam', category: 'camera', notes_path: 'Areas/x.md', quantity: 2,
      purchase_price: '12.50', currency: 'JPY', acquired_on: '2026-10-13', specs: { fov_deg: 150 },
    });
  });

  it('"none" clears nullable fields but not required ones', () => {
    expect(fieldsFrom(opts('--brand', 'none', '--price', 'none'))).toEqual({ brand: null, purchase_price: null });
    expect(() => fieldsFrom(opts('--name', 'none'))).toThrow(InventoryError);
  });

  it('rejects bad values', () => {
    expect(() => fieldsFrom(opts('--quantity', '-1'))).toThrow(/whole number/);
    expect(() => fieldsFrom(opts('--price', '12,50'))).toThrow(/--price/);
    expect(() => fieldsFrom(opts('--currency', 'dollars'))).toThrow(/3-letter/);
    expect(() => fieldsFrom(opts('--acquired', '14/10/2026'))).toThrow(/YYYY-MM-DD/);
    expect(() => fieldsFrom(opts('--specs', '[1,2]'))).toThrow(/JSON object/);
    expect(() => fieldsFrom(opts('--specs', '{nope'))).toThrow(/valid JSON/);
    expect(() => fieldsFrom(opts('--model'))).toThrow(/needs a value/);
  });
});

describe('resolveDbUrl', () => {
  it('SECONDBRAIN_DB_URL wins over the app URL; blank is ignored', () => {
    expect(resolveDbUrl({ SECONDBRAIN_DB_URL: 'postgres://sb_agent@192.0.2.10/secondbrain' }, 'postgres://localhost/secondbrain'))
      .toBe('postgres://sb_agent@192.0.2.10/secondbrain');
    expect(resolveDbUrl({ SECONDBRAIN_DB_URL: '  ' }, 'postgres://localhost/secondbrain')).toBe('postgres://localhost/secondbrain');
    expect(resolveDbUrl({}, 'postgres://localhost/secondbrain')).toBe('postgres://localhost/secondbrain');
  });
});

describe('add / update / list', () => {
  it('adds a row with defaults and returns its id', async () => {
    const item = await addItem(db, fieldsFrom(opts('--name', 'Reachy Mini', '--category', 'robot', '--price', '449', '--currency', 'USD')));
    expect(item.id).toBe(1);
    expect(item).toMatchObject({ name: 'Reachy Mini', category: 'robot', quantity: 1, status: 'owned', purchase_price: '449.00', currency: 'USD', specs: {} });
  });

  it('add needs a name and a category', async () => {
    await expect(addItem(db, fieldsFrom(opts('--name', 'x')))).rejects.toThrow(/--category/);
    await expect(addItem(db, fieldsFrom(opts('--category', 'x')))).rejects.toThrow(/--name/);
  });

  it('update sets fields, merges specs instead of replacing them, and bumps updated_at', async () => {
    const a = await addItem(db, { name: 'Cam', category: 'camera', specs: { photos: ['p1.jpg'], fov_deg: 120, app: 'HIDVCAM' } });
    await query(`UPDATE inventory_items SET updated_at = now() - interval '1 day' WHERE id = $1`, [a.id]);
    const u = await updateItem(db, a.id, fieldsFrom(opts('--model', 'X1', '--acquired', '2026-10-13', '--specs', '{"fov_deg":150,"rtsp":true}')));
    expect(u.model).toBe('X1');
    expect(u.acquired_on).toBe('2026-10-13');
    expect(u.specs).toEqual({ photos: ['p1.jpg'], fov_deg: 150, app: 'HIDVCAM', rtsp: true });
    expect(new Date(u.updated_at).getTime()).toBeGreaterThan(new Date(a.updated_at).getTime() - 1000);
    expect(u.name).toBe('Cam');
  });

  it('update refuses a missing id or an empty patch', async () => {
    await expect(updateItem(db, 99, { model: 'x' })).rejects.toThrow(/no inventory item 99/);
    const a = await addItem(db, { name: 'Cam', category: 'camera' });
    await expect(updateItem(db, a.id, {})).rejects.toThrow(/nothing to update/);
  });

  it('list searches name, brand, model, category and location, and escapes LIKE wildcards', async () => {
    await addItem(db, { name: 'Viture Pro', brand: 'Viture', category: 'xr' });
    await addItem(db, { name: 'Pi 5', category: 'computer', location: 'cyberdeck' });
    await addItem(db, { name: '100% cotton bag', category: 'bag' });
    expect((await listItems(db)).map((i) => i.name)).toEqual(['100% cotton bag', 'Pi 5', 'Viture Pro']);
    expect((await listItems(db, 'viture')).map((i) => i.name)).toEqual(['Viture Pro']);
    expect((await listItems(db, 'CYBERDECK')).map((i) => i.name)).toEqual(['Pi 5']);
    expect((await listItems(db, '%')).map((i) => i.name)).toEqual(['100% cotton bag']);
  });
});

describe('photo path logic', () => {
  it('slugifies names and file names', () => {
    expect(slugify('CUSFLYX mini Wi-Fi cube camera')).toBe('cusflyx-mini-wi-fi-cube-camera');
    expect(slugify('Café Ünïcode!!')).toBe('cafe-unicode');
    expect(slugify('***')).toBe('item');
    expect(photoFileName('/inbox/1760000000-AbC_1.JPG')).toBe('1760000000-abc-1.jpg');
    expect(photoFileName('/inbox/x.jpeg', 'Front Lens')).toBe('front-lens.jpeg');
  });

  it('picks a folder: existing photos first, then where the sources already are, else <date>_<slug>', () => {
    const fresh = { name: 'Reachy Mini', specs: {} };
    expect(choosePhotoFolder(fresh, [null], NOW)).toBe('2026-10-14_reachy-mini');
    expect(choosePhotoFolder({ name: 'Cam', specs: { photos: ['Areas/inventory/photos/2026-10-13_cusflyx/a.jpg'] } }, [null], NOW)).toBe('2026-10-13_cusflyx');
    expect(choosePhotoFolder(fresh, ['Areas/inventory/photos/2026-10-12_reachy/a.jpg', 'Areas/inventory/photos/2026-10-12_reachy/b.jpg'], NOW)).toBe('2026-10-12_reachy');
    // Sources in two different folders, or outside the photo root: a new folder.
    expect(choosePhotoFolder(fresh, ['Areas/inventory/photos/a/x.jpg', 'Areas/inventory/photos/b/y.jpg'], NOW)).toBe('2026-10-14_reachy-mini');
    expect(choosePhotoFolder(fresh, ['Areas/inventory/notes.jpg'], NOW)).toBe('2026-10-14_reachy-mini');
  });

  it('uniqueName adds -2, -3 before the extension', () => {
    const taken = new Set(['a.jpg', 'a-2.jpg']);
    expect(uniqueName('a.jpg', (n) => taken.has(n))).toBe('a-3.jpg');
    expect(uniqueName('b.jpg', (n) => taken.has(n))).toBe('b.jpg');
  });

  it('mergePhotoSpecs appends paths without duplicates and keeps b2_photos a string until a second folder', () => {
    const s0 = { fov_deg: 150, photos: ['A/a.jpg'], b2_photos: 'inventory/photos/f1/' };
    expect(mergePhotoSpecs(s0, ['A/a.jpg', 'A/b.jpg'], 'inventory/photos/f1/')).toEqual({ fov_deg: 150, photos: ['A/a.jpg', 'A/b.jpg'], b2_photos: 'inventory/photos/f1/' });
    expect(mergePhotoSpecs(s0, [], 'inventory/photos/f2/').b2_photos).toEqual(['inventory/photos/f1/', 'inventory/photos/f2/']);
    expect(mergePhotoSpecs({ b2_photos: ['x/'] }, [], 'x/').b2_photos).toEqual(['x/']);
    // No B2 this run: the old prefix stays, nothing new is claimed.
    expect(mergePhotoSpecs({}, ['A/c.jpg'], null)).toEqual({ photos: ['A/c.jpg'] });
  });

  it('resolveB2store: B2STORE env, then PATH; an unusable B2STORE means none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b2bin-'));
    const bin = join(dir, 'b2store');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(resolveB2store({ B2STORE: bin, PATH: '' })).toBe(bin);
    expect(resolveB2store({ B2STORE: join(dir, 'missing'), PATH: dir })).toBeNull();
    expect(resolveB2store({ PATH: `/nonexistent:${dir}`, HOME: dir })).toBe(bin);
    expect(resolveB2store({ PATH: '/nonexistent', HOME: dir })).toBeNull();
  });
});

describe('attachPhotos', () => {
  let vault: string;
  let inbox: string;
  beforeEach(() => {
    vault = realpathSync(mkdtempSync(join(tmpdir(), 'vault-')));
    inbox = mkdtempSync(join(tmpdir(), 'inbox-'));
    writeFileSync(join(inbox, 'IMG_1.JPG'), 'one');
    writeFileSync(join(inbox, 'img 2.png'), 'two');
  });

  it('copies into the vault, puts each file to B2 under the mirrored prefix, and records both in specs', async () => {
    const item = await addItem(db, { name: 'CUSFLYX mini Wi-Fi cube camera', category: 'camera', specs: { app: 'HIDVCAM' } });
    const calls: string[][] = [];
    const r = await attachPhotos(withTx, db, item.id, {
      vaultRoot: vault, files: [join(inbox, 'IMG_1.JPG'), join(inbox, 'img 2.png')], labels: ['Front Lens', 'back'],
      b2store: '/fake/b2store', runB2: async (_bin, args) => void calls.push(args), now: NOW,
    });
    const dir = 'Areas/inventory/photos/2026-10-14_cusflyx-mini-wi-fi-cube-camera';
    expect(r.vaultPaths).toEqual([`${dir}/front-lens.jpg`, `${dir}/back.png`]);
    expect(readFileSync(join(vault, dir, 'front-lens.jpg'), 'utf8')).toBe('one');
    expect(calls).toEqual([
      ['put', join(vault, dir, 'front-lens.jpg'), 'inventory/photos/2026-10-14_cusflyx-mini-wi-fi-cube-camera'],
      ['put', join(vault, dir, 'back.png'), 'inventory/photos/2026-10-14_cusflyx-mini-wi-fi-cube-camera'],
    ]);
    expect((await getItem(db, item.id))!.specs).toEqual({
      app: 'HIDVCAM', photos: r.vaultPaths, b2_photos: 'inventory/photos/2026-10-14_cusflyx-mini-wi-fi-cube-camera/',
    });
  });

  it('a second run reuses the folder, never overwrites a same-named photo, and appends', async () => {
    const item = await addItem(db, { name: 'Cam', category: 'camera' });
    const base = { vaultRoot: vault, b2store: '/fake', runB2: async () => {}, now: NOW };
    await attachPhotos(withTx, db, item.id, { ...base, files: [join(inbox, 'IMG_1.JPG')] });
    writeFileSync(join(inbox, 'IMG_1.JPG'), 'newer');
    const r2 = await attachPhotos(withTx, db, item.id, { ...base, files: [join(inbox, 'IMG_1.JPG')], now: new Date(2026, 9, 20) });
    expect(r2.folder).toBe('2026-10-14_cam');
    expect(r2.vaultPaths).toEqual(['Areas/inventory/photos/2026-10-14_cam/img-1-2.jpg']);
    expect(readFileSync(join(vault, 'Areas/inventory/photos/2026-10-14_cam/img-1.jpg'), 'utf8')).toBe('one');
    expect((await getItem(db, item.id))!.specs.photos).toEqual([
      'Areas/inventory/photos/2026-10-14_cam/img-1.jpg', 'Areas/inventory/photos/2026-10-14_cam/img-1-2.jpg',
    ]);
  });

  it('photos already in a vault photo folder stay where they are (dropped there before the row existed)', async () => {
    const pre = join(vault, 'Areas/inventory/photos/2026-10-13_cusflyx-mini-wifi-camera');
    mkdirSync(pre, { recursive: true });
    writeFileSync(join(pre, 'front-lens.jpg'), 'x');
    const item = await addItem(db, { name: 'CUSFLYX mini Wi-Fi cube camera', category: 'camera' });
    const r = await attachPhotos(withTx, db, item.id, { vaultRoot: vault, files: [join(pre, 'front-lens.jpg')], b2store: null, now: NOW });
    expect(r.folder).toBe('2026-10-13_cusflyx-mini-wifi-camera');
    expect(r.vaultPaths).toEqual(['Areas/inventory/photos/2026-10-13_cusflyx-mini-wifi-camera/front-lens.jpg']);
  });

  it('without b2store: warns, keeps the vault copies, records photos but no b2_photos', async () => {
    const item = await addItem(db, { name: 'Cam', category: 'camera' });
    const warnings: string[] = [];
    const r = await attachPhotos(withTx, db, item.id, { vaultRoot: vault, files: [join(inbox, 'IMG_1.JPG')], b2store: null, now: NOW, warn: (m) => warnings.push(m) });
    expect(warnings.join('\n')).toMatch(/b2store not found/);
    expect(r.b2Prefix).toBeNull();
    expect(existsSync(join(vault, r.vaultPaths[0]!))).toBe(true);
    expect((await getItem(db, item.id))!.specs).toEqual({ photos: r.vaultPaths });
  });

  it('a failed upload is reported and b2_photos is not claimed', async () => {
    const item = await addItem(db, { name: 'Cam', category: 'camera' });
    const r = await attachPhotos(withTx, db, item.id, {
      vaultRoot: vault, files: [join(inbox, 'IMG_1.JPG'), join(inbox, 'img 2.png')], b2store: '/fake', now: NOW,
      runB2: async (_b, args) => { if (args[1]!.endsWith('.png')) throw new Error('verification FAILED'); },
    });
    expect(r.b2Uploaded).toBe(1);
    expect(r.b2Errors).toHaveLength(1);
    expect((await getItem(db, item.id))!.specs.b2_photos).toBeUndefined();
  });

  it('a missing id or file writes nothing to the vault', async () => {
    await expect(attachPhotos(withTx, db, 42, { vaultRoot: vault, files: [join(inbox, 'IMG_1.JPG')], b2store: null })).rejects.toThrow(/no inventory item 42/);
    const item = await addItem(db, { name: 'Cam', category: 'camera' });
    await expect(attachPhotos(withTx, db, item.id, { vaultRoot: vault, files: [join(inbox, 'nope.jpg')], b2store: null })).rejects.toThrow(/not a file/);
    await expect(attachPhotos(withTx, db, item.id, { vaultRoot: vault, files: [join(inbox, 'IMG_1.JPG')], labels: ['a', 'b'], b2store: null })).rejects.toThrow(/--names/);
    expect(existsSync(join(vault, 'Areas'))).toBe(false);
  });
});
