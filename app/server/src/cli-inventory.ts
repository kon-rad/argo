import pg from 'pg';
import { config } from './config.js';
import { parseArgs } from './cli-projects.js';
import {
  addItem,
  attachPhotos,
  type Db,
  fieldsFrom,
  getItem,
  InventoryError,
  itemLine,
  listItems,
  resolveB2store,
  resolveDbUrl,
  updateItem,
} from './inventory.js';

const USAGE = `cli-inventory: gear in inventory_items, the master list (single-database plan, Phase 6).

  list [--search <term>] [--json]                       every item, or those whose name/brand/model/category/location match
  show <id> [--json]                                    one item, specs included
  add --name N --category C [fields] [--json]           a new item; prints the new id
  update <id> [fields] [--json]                         set fields; --specs is merged into the existing specs
  photo <id> <image...> [--names a,b] [--no-b2] [--json]
        copies the images to Areas/inventory/photos/<YYYY-MM-DD>_<slug>/ (or the item's existing folder),
        runs \`b2store put\` for each into inventory/photos/<folder>/, and appends the vault paths to
        specs.photos and the B2 prefix to specs.b2_photos

fields: --brand --model --location --notes-path <vault path> --quantity N --status owned|lent|sold|broken|...
        --price 129.99 --currency USD|MYR|JPY --acquired YYYY-MM-DD --specs '{"key": "value"}'
        Use "none" to clear a field. There is no delete.

env: SECONDBRAIN_DB_URL (wins) or DATABASE_URL; B2STORE (path to b2store; default: PATH, then ~/.local/bin)`;

const BOOL_FLAGS = ['json', 'no-b2'];

async function main(argv: string[], pool: pg.Pool): Promise<number> {
  // Boolean flags are pulled out first: parseArgs would otherwise eat the next positional as their value.
  const bools = new Set(argv.filter((a) => BOOL_FLAGS.includes(a.replace(/^--/, '')) && a.startsWith('--')).map((a) => a.slice(2)));
  const [cmd, ...rest] = argv.filter((a) => !(a.startsWith('--') && BOOL_FLAGS.includes(a.slice(2))));
  const { pos, opts } = parseArgs(rest);
  const json = bools.has('json');
  const db: Db = pool;
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const idArg = (s: string | undefined) => {
    if (!s || !/^\d+$/.test(s)) throw new InventoryError(`${cmd} needs an item id, e.g. ${cmd} 60`);
    return Number(s);
  };

  switch (cmd) {
    case 'list': {
      if (opts.search === true) throw new InventoryError('--search needs a term');
      const items = await listItems(db, typeof opts.search === 'string' ? opts.search : undefined);
      if (json) out(items);
      else if (!items.length) console.error('no items');
      else for (const i of items) console.log(itemLine(i));
      return 0;
    }
    case 'show': {
      const item = await getItem(db, idArg(pos[0]));
      if (!item) throw new InventoryError(`no inventory item ${pos[0]}`);
      if (json) out(item);
      else console.log(`${itemLine(item)}\n${item.notes_path ? `notes: ${item.notes_path}\n` : ''}specs: ${JSON.stringify(item.specs, null, 2)}`);
      return 0;
    }
    case 'add': {
      if (pos.length) throw new InventoryError(`add takes only flags; unexpected "${pos[0]}"`);
      const item = await addItem(db, fieldsFrom(opts));
      if (json) out(item);
      else {
        console.log(item.id); // stdout is the bare id so `id=$(secondbrain inventory add ...)` works
        console.error(`added inventory item ${item.id}: ${item.name}`);
      }
      return 0;
    }
    case 'update': {
      const id = idArg(pos[0]);
      const item = await updateItem(db, id, fieldsFrom(opts));
      if (json) out(item);
      else console.log(`updated ${itemLine(item)}`);
      return 0;
    }
    case 'photo': {
      const id = idArg(pos[0]);
      const files = pos.slice(1);
      const b2store = bools.has('no-b2') ? null : resolveB2store(process.env);
      if (bools.has('no-b2')) console.error('--no-b2: skipping B2');
      const withTx = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await fn(client);
          await client.query('COMMIT');
          return r;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      };
      const r = await attachPhotos(withTx, db, id, {
        vaultRoot: config.vaultRoot,
        files,
        labels: typeof opts.names === 'string' ? opts.names.split(',').map((s) => s.trim()) : undefined,
        b2store,
        warn: (m) => console.error(m),
      });
      if (json) out({ id, folder: r.folder, vault_paths: r.vaultPaths, b2_prefix: r.b2Prefix, b2_uploaded: r.b2Uploaded, b2_errors: r.b2Errors, specs: r.item.specs });
      else {
        for (const p of r.vaultPaths) console.log(p);
        console.error(`item ${id}: ${r.vaultPaths.length} photo(s) in ${r.folder}; B2 ${r.b2Prefix ? `${r.b2Uploaded} uploaded to ${r.b2Prefix}` : 'skipped or incomplete'}`);
      }
      return r.b2Errors.length ? 2 : 0;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli-inventory.js') || process.argv[1]?.endsWith('cli-inventory.ts')) {
  const pool = new pg.Pool({ connectionString: resolveDbUrl(process.env, config.databaseUrl), max: 2 });
  let code = 1;
  try {
    code = await main(process.argv.slice(2), pool);
  } catch (err) {
    if (err instanceof InventoryError) console.error(err.message);
    else if (err instanceof Error && 'code' in err && err.code === '42501')
      console.error(`permission denied: ${err.message} (sb_agent may insert and update inventory_items, nothing else)`);
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  process.exit(code);
}
