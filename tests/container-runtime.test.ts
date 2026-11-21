import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { 
  resolveDockerBinary, 
  normalizeHostPathForDocker, 
  formatMountArg, 
  buildDockerRunArgs,
  type ContainerSpec 
} from '../src/container-runtime.js';

describe('Phase 7 - Step 1: Container Runtime & Mount Composition Engine', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('resolveDockerBinary', () => {
    it('honors DOCKER_BIN environment override if provided', () => {
      process.env.DOCKER_BIN = '/custom/bin/docker';
      expect(resolveDockerBinary()).toBe('/custom/bin/docker');
    });

    it('returns a valid string fallback when DOCKER_BIN is unset', () => {
      delete process.env.DOCKER_BIN;
      const bin = resolveDockerBinary();
      expect(typeof bin).toBe('string');
      expect(bin.length).toBeGreaterThan(0);
      expect(bin.toLowerCase()).toContain('docker');
    });
  });

  describe('normalizeHostPathForDocker', () => {
    it('normalizes Windows drive letters to POSIX path format', () => {
      if (process.platform === 'win32') {
        const normalized = normalizeHostPathForDocker('C:\\Users\\test\\project');
        expect(normalized).toBe('/c/Users/test/project');

        const normalizedD = normalizeHostPathForDocker('D:\\data\\sessions\\ag-1\\s-1');
        expect(normalizedD).toBe('/d/data/sessions/ag-1/s-1');
      } else {
        const resolved = path.resolve('/tmp/test');
        expect(normalizeHostPathForDocker('/tmp/test')).toBe(resolved);
      }
    });

    it('handles paths with mixed slashes', () => {
      if (process.platform === 'win32') {
        const normalized = normalizeHostPathForDocker('C:/Users/test/mixed/path');
        expect(normalized).toBe('/c/Users/test/mixed/path');
      }
    });
  });

  describe('formatMountArg', () => {
    it('formats a volume mount string with normalized host path, target container path, and mode', () => {
      const mountArg = formatMountArg({
        hostPath: process.platform === 'win32' ? 'C:\\data\\session' : '/data/session',
        containerPath: '/workspace/session',
        mode: 'rw'
      });

      if (process.platform === 'win32') {
        expect(mountArg).toBe('/c/data/session:/workspace/session:rw');
      } else {
        expect(mountArg).toContain('/data/session:/workspace/session:rw');
      }
    });
  });

  describe('buildDockerRunArgs', () => {
    const baseSpec: ContainerSpec = {
      containerName: 'protoclaw-assistant-sess-1',
      imageName: 'protoclaw-runner:latest',
      agentGroupId: 'assistant',
      sessionId: 'sess-1',
      sessionDir: process.platform === 'win32' ? 'C:\\data\\sessions\\assistant\\sess-1' : '/data/sessions/assistant/sess-1',
      workspaceDir: process.platform === 'win32' ? 'C:\\groups\\assistant\\workspace' : '/groups/assistant/workspace',
      memoryLimit: '512m',
      cpuLimit: '1.5',
      pidsLimit: '50',
      network: 'none',
      env: {
        CUSTOM_VAR: 'hello-world'
      }
    };

    it('generates the complete docker run argument list with security and resource flags', () => {
      const args = buildDockerRunArgs(baseSpec);

      // Verify core flags
      expect(args[0]).toBe('run');
      expect(args).toContain('-d');
      expect(args).toContain('--rm');
      expect(args).toContain('--name');
      expect(args[args.indexOf('--name') + 1]).toBe('protoclaw-assistant-sess-1');

      // Verify security hardening flags
      expect(args).toContain('--init'); // Tini process supervisor for SQLite commit safety
      expect(args).toContain('--pids-limit');
      expect(args[args.indexOf('--pids-limit') + 1]).toBe('50');
      expect(args).toContain('--memory');
      expect(args[args.indexOf('--memory') + 1]).toBe('512m');
      expect(args).toContain('--cpus');
      expect(args[args.indexOf('--cpus') + 1]).toBe('1.5');
      expect(args).toContain('--network');
      expect(args[args.indexOf('--network') + 1]).toBe('none');

      // Verify session mailbox and workspace mounts
      expect(args).toContain('-v');
      const mountArgs = args.filter((_, idx) => args[idx - 1] === '-v');
      expect(mountArgs.some((m) => m.includes('/workspace/session:rw'))).toBe(true);
      expect(mountArgs.some((m) => m.includes('/workspace/project:rw'))).toBe(true);

      // Verify environment variables
      expect(args).toContain('-e');
      expect(args).toContain('SESSION_ID=sess-1');
      expect(args).toContain('AGENT_GROUP_ID=assistant');
      expect(args).toContain('NODE_ENV=production');
      expect(args).toContain('CUSTOM_VAR=hello-world');

      // Verify working directory and image name
      expect(args).toContain('-w');
      expect(args[args.indexOf('-w') + 1]).toBe('/workspace/project');
      expect(args[args.length - 1]).toBe('protoclaw-runner:latest');
    });

    it('includes optional read-only runner code mount when runnerCodeDir is provided', () => {
      const specWithCode: ContainerSpec = {
        ...baseSpec,
        runnerCodeDir: process.platform === 'win32' ? 'C:\\protoclaw\\src' : '/protoclaw/src'
      };

      const args = buildDockerRunArgs(specWithCode);
      const mountArgs = args.filter((_, idx) => args[idx - 1] === '-v');
      expect(mountArgs.length).toBe(3);
      expect(mountArgs.some((m) => m.includes('/app/runner:ro'))).toBe(true);
    });
  });
});
