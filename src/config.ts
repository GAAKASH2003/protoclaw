import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

export const PROJECT_ROOT =
  fs.existsSync(path.resolve(process.cwd(), 'package.json')) &&
  (() => {
    try {
      return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).name === 'protoclaw';
    } catch {
      return false;
    }
  })()
    ? process.cwd()
    : packageRoot;

// Native Node 22 environment file loading
if (typeof process.loadEnvFile === 'function') {
  const envPaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(packageRoot, '.env')
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      try {
        process.loadEnvFile(envPath);
        break;
      } catch {
        // ignore error
      }
    }
  }
}

export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CENTRAL_DB_PATH = path.join(DATA_DIR, 'protoclaw.db');
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');

export const DEFAULT_POLL_INTERVAL_MS = 500;
export const HEARTBEAT_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_ASSISTANT_NAME = 'ProtoClaw';

export const CONTAINER_RUNNER = process.env.CONTAINER_RUNNER === 'true';
// Image tag to launch
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'protoclaw-runner:latest';
// Automatic idle timeout before stopping container (default: 60 seconds)
export const CONTAINER_IDLE_TIMEOUT_MS = process.env.CONTAINER_IDLE_TIMEOUT_MS
  ? Number(process.env.CONTAINER_IDLE_TIMEOUT_MS)
  : 60_000;
  
