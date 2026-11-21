import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


export interface MountSpec{
    hostPath: string;
    containerPath: string;
    mode:'ro'|'rw';
}

export interface ContainerSpec{
    containerName: string;
    imageName: string;
    agentGroupId: string;
    sessionId: string;
    sessionDir:string;
    workspaceDir:string;
    runnerCodeDir?: string;
    env?:Record<string,string>;
    memoryLimit?:string;
    cpuLimit?:string;
    pidsLimit?:string;
    network?:string;
}

export interface ActiveContainerInfo {
  containerId: string;
  containerName: string;
  agentGroupId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface ContainerRuntimeDriver {
  run(spec: ContainerSpec): Promise<string>;
  stop(containerName: string, timeoutSec?: number): Promise<void>;
  ps(filterPrefix?: string): Promise<string[]>;
  isDaemonRunning(): Promise<boolean>;
}
// Default production driver delegates directly to src/container-runtime.ts


// Key: "agentGroupId:sessionId" -> ActiveContainerInfo
const activeContainers = new Map<string, ActiveContainerInfo>();

const execFileAsync = promisify(execFile);

export function resolveDockerBinary(): string {
  if (process.env.DOCKER_BIN) {
    return process.env.DOCKER_BIN;
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const desktopPath = path.join(
      localAppData,
      'Programs',
      'DockerDesktop',
      'resources',
      'bin',
      'docker.exe'
    );
    if (fs.existsSync(desktopPath)) {
      return desktopPath;
    }
  }

  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

export function normalizeHostPathForDocker(hostPath: string): string {
  const resolved = path.resolve(hostPath);
  
  if (process.platform === 'win32') {
    // Matches drive letter like "C:\" or "c:/"
    const match = resolved.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (match) {
      const drive = match[1].toLowerCase();
      const rest = match[2].replace(/\\/g, '/');
      return `/${drive}/${rest}`;
    }
    return resolved.replace(/\\/g, '/');
  }

  return resolved;
}

export function formatMountArg(mount: MountSpec): string{
    const normalizedHost=normalizeHostPathForDocker(mount.hostPath);
    return `${normalizedHost}:${mount.containerPath}:${mount.mode}`; 
}

export function buildDockerRunArgs(spec: ContainerSpec):string[]{
    const args:string[]=[
        'run',
        '-d',
        '--rm',
        '--name', spec.containerName,
        '--init',
        '--pids-limit', String(spec.pidsLimit ?? 100),
        '--memory', spec.memoryLimit ?? '1024m',
        '--cpus', spec.cpuLimit ?? '2.0',
        '--network', spec.network ?? 'bridge'
    ];

    args.push('-v', formatMountArg({
        hostPath: spec.sessionDir,
        containerPath: '/workspace/session',
        mode: 'rw'
    }));

    args.push('-v', formatMountArg({
        hostPath: spec.workspaceDir,
        containerPath: '/workspace/project',
        mode: 'rw'
    }));

    if (spec.runnerCodeDir) {
        args.push('-v', formatMountArg({
        hostPath: spec.runnerCodeDir,
        containerPath: '/app/runner',
        mode: 'ro'
        }));
    }

    args.push('-e', `SESSION_ID=${spec.sessionId}`);
    args.push('-e', `AGENT_GROUP_ID=${spec.agentGroupId}`);
    args.push('-e', 'NODE_ENV=production');
    if (spec.env) {
        for (const [key, value] of Object.entries(spec.env)) {
        args.push('-e', `${key}=${value}`);
        }
    }
    // Image name & container entrypoint working directory
    args.push('-w', '/workspace/project');
    args.push(spec.imageName);
    return args;
};

export async function dockerRun(spec: ContainerSpec):Promise<string>{
  const dockerBin = resolveDockerBinary();
  const args = buildDockerRunArgs(spec);
  const { stdout } = await execFileAsync(dockerBin, args);
  return stdout.trim(); 
}

export async function dockerStop(containerName: string, timeoutSec = 5): Promise<void> {
  const dockerBin = resolveDockerBinary();
  await execFileAsync(dockerBin, ['stop', '-t', String(timeoutSec), containerName]);
}

export async function dockerPs(filterPrefix = 'protoclaw-'): Promise<string[]> {
  const dockerBin = resolveDockerBinary();
  const { stdout } = await execFileAsync(dockerBin, [
    'ps',
    '--filter', `name=${filterPrefix}`,
    '--format', '{{.Names}}'
  ]);
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

export async function isDockerDaemonRunning(): Promise<boolean> {
  const dockerBin = resolveDockerBinary();
  try {
    await execFileAsync(dockerBin, ['info']);
    return true;
  } catch {
    return false;
  }
}
