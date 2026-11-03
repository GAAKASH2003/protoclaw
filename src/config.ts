import path from 'path';

export const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CENTRAL_DB_PATH = path.join(DATA_DIR, 'protoclaw.db');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');

export const DEFAULT_POLL_INTERVAL_MS = 500;
export const HEARTBEAT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_ASSISTANT_NAME = 'ProtoClaw';
