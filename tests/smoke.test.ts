import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, DEFAULT_ASSISTANT_NAME } from '../src/config.js';

describe('Phase 0 Smoke Test', () => {
  it('loads configuration constants correctly', () => {
    expect(PROJECT_ROOT).toBeDefined();
    expect(DEFAULT_ASSISTANT_NAME).toBe('ProtoClaw');
  });

  it('runs modern ECMAScript features', () => {
    const list = [1, 2, 3];
    expect(list.at(-1)).toBe(3);
  });

  it('executes Node 22 native SQLite operations synchronously', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE smoke_check (key TEXT PRIMARY KEY, value INT);');
    const insert = db.prepare('INSERT INTO smoke_check (key, value) VALUES (?, ?);');
    insert.run('parity', 42);

    const row = db.prepare('SELECT value FROM smoke_check WHERE key = ?;').get('parity') as { value: number };
    expect(row).toBeDefined();
    expect(row.value).toBe(42);
    db.close();
  });
});
