import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { CENTRAL_DB_PATH } from '../config.js';
import { SCHEMA } from './schema.js';

let _centralDb: DatabaseSync | null = null;

export function openCentralDb(dbPath:string=CENTRAL_DB_PATH):
DatabaseSync{
    const dir=path.dirname(dbPath);
    if(!fs.existsSync(dir)){
        fs.mkdirSync(dir,{
            recursive:true,
        })
    }
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');

    return db;
}


export function initCentralDb(dbPath: string = CENTRAL_DB_PATH): DatabaseSync {
  const db = openCentralDb(dbPath);
  db.exec(SCHEMA);
  return db;
}

export function getCentralDb(dbPath: string = CENTRAL_DB_PATH): DatabaseSync {
  if (!_centralDb) {
    _centralDb = initCentralDb(dbPath);
  }
  return _centralDb;
}


export function closeCentralDb(): void {
  if (_centralDb) {
    _centralDb.close();
    _centralDb = null;
  }
}
