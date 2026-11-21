import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { 
  wakeContainer, 
  stopContainer, 
  reapOrphans, 
  stopAllContainers,
  activeContainers, 
  type ContainerRuntimeDriver 
} from '../src/container-runner.js';
import type { ContainerSpec } from '../src/container-runtime.js';

describe('Phase 7 - Step 3: Container Lifecycle Manager', () => {
  let mockDriver: ContainerRuntimeDriver;
  let spawnedSpecs: ContainerSpec[] = [];
  let stoppedContainers: string[] = [];
  let psContainers: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    spawnedSpecs = [];
    stoppedContainers = [];
    psContainers = [];
    activeContainers.clear();

    mockDriver = {
      run: vi.fn().mockImplementation(async (spec: ContainerSpec) => {
        spawnedSpecs.push(spec);
        psContainers.push(spec.containerName);
        return `mock-cid-${spec.containerName}`;
      }),
      stop: vi.fn().mockImplementation(async (containerName: string) => {
        stoppedContainers.push(containerName);
        psContainers = psContainers.filter((name) => name !== containerName);
      }),
      ps: vi.fn().mockImplementation(async (prefix?: string) => {
        if (!prefix) return psContainers;
        return psContainers.filter((name) => name.startsWith(prefix));
      }),
      isDaemonRunning: vi.fn().mockResolvedValue(true)
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    activeContainers.clear();
  });

  describe('wakeContainer', () => {
    it('spawns a new container on cold start and schedules idle timeout', async () => {
      const result = await wakeContainer('assistant', 'sess-100', {
        driver: mockDriver,
        idleTimeoutMs: 30_000,
        env: { CUSTOM_CONFIG: 'value123' }
      });

      expect(result.status).toBe('spawned');
      expect(result.containerName).toBe('protoclaw-assistant-sess-100');
      expect(result.containerId).toBe('mock-cid-protoclaw-assistant-sess-100');
      expect(mockDriver.run).toHaveBeenCalledTimes(1);

      // Verify spec passed to driver
      expect(spawnedSpecs.length).toBe(1);
      const spec = spawnedSpecs[0];
      expect(spec.agentGroupId).toBe('assistant');
      expect(spec.sessionId).toBe('sess-100');
      expect(spec.env?.CUSTOM_CONFIG).toBe('value123');
      expect(spec.sessionDir).toContain('sess-100');
      expect(spec.workspaceDir).toContain('workspace');

      // Verify tracked in activeContainers
      expect(activeContainers.has('assistant:sess-100')).toBe(true);
    });

    it('reuses active container warmly and resets idle timeout without cold start', async () => {
      // 1. Initial wake
      await wakeContainer('assistant', 'sess-200', {
        driver: mockDriver,
        idleTimeoutMs: 30_000
      });
      expect(mockDriver.run).toHaveBeenCalledTimes(1);

      // 2. Advance time by 20s (still within 30s timeout)
      vi.advanceTimersByTime(20_000);

      // 3. Second wake for another turn
      const warmResult = await wakeContainer('assistant', 'sess-200', {
        driver: mockDriver,
        idleTimeoutMs: 30_000
      });

      expect(warmResult.status).toBe('already_running');
      expect(warmResult.containerName).toBe('protoclaw-assistant-sess-200');
      // Driver run should NOT be called again
      expect(mockDriver.run).toHaveBeenCalledTimes(1);

      // 4. Advance time by another 20s (40s total from start, but 20s from second wake)
      vi.advanceTimersByTime(20_000);
      // Container should still be alive because timer was reset!
      expect(mockDriver.stop).not.toHaveBeenCalled();

      // 5. Advance time by 15s more (exceeds the 30s from second wake)
      vi.advanceTimersByTime(15_000);
      // Now it should have auto-stopped
      expect(mockDriver.stop).toHaveBeenCalledWith('protoclaw-assistant-sess-200', 5);
      expect(activeContainers.has('assistant:sess-200')).toBe(false);
    });
  });

  describe('stopContainer', () => {
    it('gracefully stops an active container and clears its idle timer', async () => {
      await wakeContainer('coder', 'sess-300', { driver: mockDriver });
      expect(activeContainers.has('coder:sess-300')).toBe(true);

      const stopped = await stopContainer('coder', 'sess-300', { driver: mockDriver, timeoutSec: 3 });
      expect(stopped).toBe(true);
      expect(mockDriver.stop).toHaveBeenCalledWith('protoclaw-coder-sess-300', 3);
      expect(activeContainers.has('coder:sess-300')).toBe(false);
    });
  });

  describe('reapOrphans', () => {
    it('detects and terminates orphaned containers left over from previous host runs', async () => {
      // Container 1: currently active and tracked by host
      await wakeContainer('assistant', 'active-sess', { driver: mockDriver });

      // Container 2 & 3: left running in Docker from a previous host crash
      psContainers.push('protoclaw-default-zombie-1');
      psContainers.push('protoclaw-assistant-zombie-2');

      const { reaped } = await reapOrphans(mockDriver);

      expect(reaped).toEqual(['protoclaw-default-zombie-1', 'protoclaw-assistant-zombie-2']);
      expect(mockDriver.stop).toHaveBeenCalledWith('protoclaw-default-zombie-1', 2);
      expect(mockDriver.stop).toHaveBeenCalledWith('protoclaw-assistant-zombie-2', 2);

      // Active container was NOT reaped
      expect(activeContainers.has('assistant:active-sess')).toBe(true);
      expect(mockDriver.stop).not.toHaveBeenCalledWith('protoclaw-assistant-active-sess', expect.anything());
    });
  });

  describe('stopAllContainers', () => {
    it('stops all active containers concurrently on host shutdown', async () => {
      await wakeContainer('ag-1', 's-1', { driver: mockDriver });
      await wakeContainer('ag-2', 's-2', { driver: mockDriver });

      expect(activeContainers.size).toBe(2);

      await stopAllContainers(mockDriver);

      expect(stoppedContainers).toContain('protoclaw-ag-1-s-1');
      expect(stoppedContainers).toContain('protoclaw-ag-2-s-2');
      expect(activeContainers.size).toBe(0);
    });
  });
});
