/**
 * Process helpers.
 *
 * Security rule of this project: user input NEVER reaches a shell. All system
 * commands are built from a fixed whitelist of binaries (java, cloudflared,
 * ps/tasklist for metrics) and receive their arguments as an argv array with
 * `shell: false`.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathExistsSync } from './fsx.js';

/** Binaries the panel is allowed to execute. Everything else is refused. */
export const ALLOWED_BINARIES = new Set(['java', 'javaw', 'cloudflared', 'playit', 'ps', 'tasklist', 'uname', 'java.exe', 'cloudflared.exe', 'playit.exe']);

export function assertAllowedBinary(bin) {
  const base = path.basename(String(bin)).toLowerCase().replace(/\.(exe|bat|cmd|sh|ps1)$/, '');
  if (!ALLOWED_BINARIES.has(base) && !ALLOWED_BINARIES.has(`${base}.exe`)) {
    throw new Error(`Refusing to execute "${bin}": not in the allowed binary list.`);
  }
  return bin;
}

export function isWindows() {
  return process.platform === 'win32';
}

/** Append the platform executable suffix when needed. */
export function executableName(base) {
  return isWindows() ? `${base}.exe` : base;
}

/**
 * Spawn a long running process (Minecraft, e4mc relay, cloudflared).
 * Returns the ChildProcess; stdout/stderr are piped, never inherited.
 */
export function spawnProcess(command, args = [], { cwd, env = {}, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  assertAllowedBinary(command);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio,
    shell: false,
    windowsHide: true,
  });
  // A process that is tearing down closes its stdin before we stop writing to it.
  // That arrives as an 'error' event on the stream - and an unhandled stream error is
  // an uncaughtException: stopping a server used to log two full ERROR traces while the
  // panel was doing exactly the right thing. Record it instead, so the writer can report
  // it as what it is ("the console was already closing"), and never crash over it.
  if (child.stdin && typeof child.stdin.on === 'function') {
    child.stdin.on('error', (err) => {
      child.stdinError = { message: err?.message || 'stdin error', code: err?.code || 'EPIPE' };
    });
  }
  return child;
}

/** True when the child's stdin already refused a write (it is exiting or gone). */
export function stdinIsGone(child) {
  return Boolean(child?.stdinError) || !child?.stdin || child.stdin.destroyed === true || child.stdin.writable === false;
}

/**
 * Run a short lived command and capture its output.
 * Only whitelisted binaries, arguments are never interpolated into a shell.
 */
export function runCommand(command, args = [], { timeoutMs = 15000, cwd, input = null, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, { cwd, env });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${timeoutMs} ms: ${path.basename(command)}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(Object.assign(new Error(`Executable not found: ${command}`), { code: 'ENOENT' }));
      } else reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (input !== null) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Resolve a Java executable.
 * Priority: explicit config -> JAVA_HOME -> PATH -> well known install dirs.
 */
export function resolveJavaCandidates(configured = '') {
  const exe = executableName('java');
  const candidates = [];
  if (configured && configured.trim()) candidates.push(path.resolve(configured.trim()));
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  candidates.push(exe); // rely on PATH
  if (isWindows()) {
    candidates.push(
      'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe',
      'C:\\Program Files\\Microsoft\\jdk-21*\\bin\\java.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium', 'jdk-21', 'bin', 'java.exe'),
      path.join(process.env.ProgramData || '', 'Oracle', 'Java', 'javapath', 'java.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/opt/openjdk@21/bin/java', '/usr/local/opt/openjdk@21/bin/java', '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java');
  } else {
    candidates.push('/usr/lib/jvm/temurin-21-jdk-amd64/bin/java', '/usr/lib/jvm/java-21-openjdk-amd64/bin/java', '/usr/bin/java', '/usr/local/bin/java');
  }
  // de-duplicate while keeping order, drop empty entries
  return [...new Set(candidates.filter(Boolean))];
}

export function whichSync(binary, { extraDirs = [] } = {}) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extraDirs);
  for (const dir of dirs) {
    if (!dir) continue;
    const full = path.join(dir, binary);
    if (pathExistsSync(full)) return full;
  }
  return null;
}

/** CPU count available for recommendations. */
export function cpuCount() {
  return os.cpus()?.length || 2;
}

export function totalMemoryMb() {
  return Math.floor(os.totalmem() / (1024 * 1024));
}

/** Gracefully close a child process: SIGTERM, then SIGKILL after a delay. */
export async function terminateProcess(child, { graceMs = 10000, signal = 'SIGTERM' } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', done);
    try {
      if (isWindows()) child.kill();
      else child.kill(signal);
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        if (isWindows()) child.kill('SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(false);
    }, graceMs);
  });
}
