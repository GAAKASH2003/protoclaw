/**
 * src/container-runner.ts
 * Container Lifecycle Manager for ProtoClaw.
 * 
 * Manages the lifecycle of agent runner containers on the Host:
 * - wakeContainer: Warm container reuse + scale-to-zero idle timeout
 * - stopContainer: Graceful SIGTERM stop with SQLite commit safety
 * - reapOrphans: Zombie container cleanup on host boot
 */

import { 
  dockerRun, 
  dockerStop, 
  dockerPs, 
  isDockerDaemonRunning,
  type ContainerSpec 
} from './container-runtime.js';
import { sessionDir } from './session-manager.js';
import { ensureGroupWorkspace } from './project-doc-compose.js';

export interface ContainerRuntimeDriver {
  run(spec: ContainerSpec): Promise<string>;
  stop(containerName: string, timeoutSec?: number): Promise<void>;
  ps(filterPrefix?: string): Promise<string[]>;
  isDaemonRunning(): Promise<boolean>;
}

export const defaultRuntimeDriver: ContainerRuntimeDriver = {
  run: dockerRun,
  stop: dockerStop,
  ps: dockerPs,
  isDaemonRunning: isDockerDaemonRunning
};

export interface ActiveContainerInfo {
  containerId: string;
  containerName: string;
  agentGroupId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

// In-memory active container registry: "agentGroupId:sessionId" -> ActiveContainerInfo
export const activeContainers = new Map<string, ActiveContainerInfo>();

export interface WakeOptions {
  imageName?: string;
  idleTimeoutMs?: number; // e.g. 60_000ms (1 minute)
  driver?: ContainerRuntimeDriver;
  env?: Record<string, string>;
}

export async function wakeContainer(
  agentGroupId: string,
  sessionId: string,
  options: WakeOptions = {}
): Promise<{ status: 'spawned' | 'already_running'; containerName: string; containerId?: string }> {
  const driver = options.driver || defaultRuntimeDriver;
  const sessionKey = `${agentGroupId}:${sessionId}`;
  const containerName = `protoclaw-${agentGroupId}-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const idleTimeout = options.idleTimeoutMs ?? 60_000;

  // 1. Check if container is already warm
  const existing = activeContainers.get(sessionKey);
  if (existing) {
    // Reset the idle shutdown timer
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.lastActivityAt = Date.now();
    existing.idleTimer = setTimeout(() => {
      stopContainer(agentGroupId, sessionId, { driver }).catch(console.error);
    }, idleTimeout);

    return { status: 'already_running', containerName, containerId: existing.containerId };
  }

  // 2. Cold Start: Resolve host directory paths
  const sDir = sessionDir(agentGroupId, sessionId);
  const paths = ensureGroupWorkspace(agentGroupId);

  // 3. Forward Host API Keys into container environment
  const env: Record<string, string> = {
    ...options.env
  };
  if (process.env.GEMINI_API_KEY) env.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (process.env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

  // 4. Compose ContainerSpec
  const spec: ContainerSpec = {
    containerName,
    imageName: options.imageName || process.env.CONTAINER_IMAGE || 'protoclaw-runner:latest',
    agentGroupId,
    sessionId,
    sessionDir: sDir,
    workspaceDir: paths.workspaceDir,
    env
  };

  // 5. Spawn via Docker
  const containerId = await driver.run(spec);

  // 6. Schedule auto-shutdown when idle
  const idleTimer = setTimeout(() => {
    stopContainer(agentGroupId, sessionId, { driver }).catch(console.error);
  }, idleTimeout);

  activeContainers.set(sessionKey, {
    containerId,
    containerName,
    agentGroupId,
    sessionId,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    idleTimer
  });

  return { status: 'spawned', containerName, containerId };
}

export async function stopContainer(
  agentGroupId: string,
  sessionId: string,
  options: { driver?: ContainerRuntimeDriver; timeoutSec?: number } = {}
): Promise<boolean> {
  const driver = options.driver || defaultRuntimeDriver;
  const sessionKey = `${agentGroupId}:${sessionId}`;
  const info = activeContainers.get(sessionKey);
  const containerName = info?.containerName || `protoclaw-${agentGroupId}-${sessionId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

  if (info?.idleTimer) {
    clearTimeout(info.idleTimer);
  }
  activeContainers.delete(sessionKey);

  try {
    // Sends SIGTERM first, waiting up to timeoutSec (default 5s) for SQLite to commit cleanly
    await driver.stop(containerName, options.timeoutSec ?? 5);
    return true;
  } catch {
    return false;
  }
}

export async function reapOrphans(
  driver: ContainerRuntimeDriver = defaultRuntimeDriver
): Promise<{ reaped: string[] }> {
  const runningNames = await driver.ps('protoclaw-');
  const activeNames = new Set(Array.from(activeContainers.values()).map((c) => c.containerName));
  const reaped: string[] = [];

  for (const name of runningNames) {
    // If running in Docker but NOT managed by current host process, it is an orphan
    if (!activeNames.has(name)) {
      try {
        await driver.stop(name, 2);
        reaped.push(name);
      } catch {}
    }
  }

  return { reaped };
}

export async function stopAllContainers(
  driver: ContainerRuntimeDriver = defaultRuntimeDriver
): Promise<void> {
  const tasks = Array.from(activeContainers.keys()).map((key) => {
    const [agentGroupId, sessionId] = key.split(':');
    return stopContainer(agentGroupId, sessionId, { driver });
  });
  await Promise.all(tasks);
}
