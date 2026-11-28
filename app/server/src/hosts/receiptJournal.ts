import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { commandResult, type CommandResult } from '@secondbrain/contracts/hosts';

type Fence = { attempt: string; generation: number };

// A separate SQLite lock survives commits to the receipt DB and is released by
// the OS on process exit. Two workers cannot recover the same live execution.
export class ReceiptJournal {
  private readonly lock: DatabaseSync;
  private readonly db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error('Host receipt directory must be private to the worker');
    }
    this.lock = new DatabaseSync(join(dir, 'worker.lock'));
    try {
      this.lock.exec('BEGIN EXCLUSIVE');
      this.db = new DatabaseSync(join(dir, 'receipts.sqlite'));
      this.db.exec(`PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;
        CREATE TABLE IF NOT EXISTS receipt (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), attempt TEXT NOT NULL,
          generation INTEGER NOT NULL, result TEXT
        )`);
      chmodSync(join(dir, 'receipts.sqlite'), 0o600);
    } catch (error) {
      this.lock.close();
      throw error;
    }
  }

  begin(fence: Fence) {
    this.db.prepare('INSERT INTO receipt(singleton,attempt,generation) VALUES (1,?,?)').run(fence.attempt, fence.generation);
  }

  save(result: CommandResult) {
    this.db.prepare('UPDATE receipt SET result=? WHERE attempt=? AND generation=?')
      .run(JSON.stringify(result), result.attempt, result.generation);
  }

  pending(): CommandResult | null {
    const row = this.db.prepare('SELECT attempt,generation,result FROM receipt').get();
    if (!row) return null;
    if (row.result) return commandResult.parse(JSON.parse(String(row.result)));
    return commandResult.parse({ attempt: row.attempt, generation: row.generation, outcome: 'unknown',
      reason: 'Worker restarted before recording a terminal result' });
  }

  acknowledge() { this.db.exec('DELETE FROM receipt'); }
  close() { this.db.close(); this.lock.close(); }
}
