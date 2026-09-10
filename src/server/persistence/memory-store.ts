/**
 * In-memory host store (Plan B9). It is `SqliteStore` on SQLite's `:memory:` database rather than a
 * second Map-based implementation: the retention, receipt and transaction rules are the product, and
 * a test double with its own copy of those rules would prove nothing about the real one. Tests that
 * want the file, WAL and migration paths use a real path; tests that want speed use this.
 */

import { SqliteStore } from './sqlite-store.ts';

export class MemoryStore extends SqliteStore {
  constructor(now?: () => string) {
    super({ path: ':memory:', now });
  }
}
