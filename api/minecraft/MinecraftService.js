/**
 * MinecraftServerService - lifecycle of the dedicated server process.
 *
 * Responsibilities
 *   - validate the environment before every start (Java, installation, EULA, port)
 *   - spawn `java @user_jvm_args.txt @<neoforge args file> nogui` (exactly what
 *     the official NeoForge run script does)
 *   - stream stdout/stderr into the console buffer and the log parser
 *   - expose a real state machine: stopped | starting | online | stopping | error
 *   - graceful stop (`stop` on stdin), force kill, restart
 *   - collect genuine metrics (RSS/CPU from the OS, TPS from the server itself)
 *
 * Commands typed in the panel go to the server's own console via stdin - they
 * are never passed to a shell.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnProcess, terminateProcess, isWindows, stdinIsGone } from '../util/proc.js';
import { AppError, ConflictError } from '../util/errors.js';
import { pathExists } from '../util/fsx.js';
import { canConnect, isPortFree } from '../util/net.js';
import { getProcessStats } from '../util/procstats.js';
import { neoforgeArgsFile } from '../util/mcversions.js';
import { LogParser } from './LogParser.js';
import { ConsoleService } from './ConsoleService.js';

export const STATES = {
  STOPPED: 'stopped',
  INSTALLING: 'installing',
  STARTING: 'starting',
  ONLINE: 'online',
  STOPPING: 'stopping',
  ERROR: 'error',
};

const MAX_COMMAND_LENGTH = 512;

export class MinecraftService extends EventEmitter {
  constructor({ config, logs, java, install, events, players = null, console: consoleService = null }) {
    super();
    this.config = config;
    this.logs = logs;
    this.log = logs.minecraft;
    this.java = java;
    this.install = install;
    this.events = events;
    this.players = players;

    this.state = STATES.STOPPED;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastExit = null;
    this.lastError = null;
    this.warnings = [];
    this.slowStart = false;
    this.pendingRestart = false;
    this.restarting = false;
    this.startAttempts = 0;
    this.console = consoleService || new ConsoleService({ logs });
    this.parser = new LogParser({ onEvent: (event) => this.onParserEvent(event) });
    this.metricsTimer = null;
    this.keepAliveTimer = null;
    this.lastMetrics = null;
    this.stopPromise = null;
    this.exitWaiters = [];
    this.commandHistory = [];
  }

  // ------------------------------------------------------------------ state

  async start() {
    // register the periodic tasks once the panel boots
    this.log.info(`Minecraft service ready (${this.config.values.minecraft.version} / NeoForge ${this.config.values.minecraft.neoforge_version}).`);
  }

  async stop() {
    if (this.isRunning()) {
      if (this.config.values.minecraft.stop_on_panel_exit !== false) {
        this.log.info('Panel is shutting down: sending "stop" to the Minecraft server...');
        try {
          await this.requestStop({ reason: 'panel shutdown' });
        } catch (err) {
          this.log.error(`Graceful stop failed during shutdown: ${err.message}`);
          await this.kill({ reason: 'panel shutdown fallback' });
        }
      } else {
        this.log.warn('Panel is shutting down and [minecraft].stop_on_panel_exit is false: the server keeps running.');
      }
    }
    this.clearTimers();
  }

  setState(state, { reason = null, error = null } = {}) {
    if (this.state === state && !reason) return;
    const previous = this.state;
    this.state = state;
    if (error) this.lastError = error;
    const payload = {
      state,
      previous,
      reason,
      error: error || undefined,
      online: state === STATES.ONLINE,
      at: new Date().toISOString(),
      snapshot: this.status(),
    };
    this.log.info(`Server state: ${previous} -> ${state}${reason ? ` (${reason})` : ''}`);
    this.events?.publish('status', payload);
    this.emit('state', payload);
  }

  isRunning() {
    return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null;
  }

  // ------------------------------------------------------------------ start

  /** Full pre-flight validation with explicit, actionable errors. */
  async preflight({ checkPort = true } = {}) {
    const issues = [];
    const mc = this.config.values.minecraft;

    const java = await this.java.detect({ force: true });
    if (!java.found) issues.push({ code: 'JAVA_NOT_FOUND', severity: 'error', message: java.error, hint: java.hint });
    else if (!java.meetsRequirement) {
      issues.push({ code: 'JAVA_VERSION_MISMATCH', severity: 'error', message: `Java ${java.version.feature} found at ${java.path} but Java ${java.requiredJava} is required.`, hint: `Install Java ${java.requiredJava} and set [minecraft].java_path.` });
    }

    const status = await this.install.status();
    if (!status.steps.neoforge) {
      issues.push({
        code: 'NEOFORGE_MISSING',
        severity: 'error',
        message: `NeoForge is not installed in ${this.config.paths.serverDir}.`,
        hint: 'Open Settings -> Install / Repair and run the installation (it downloads the official NeoForge installer).',
      });
    }
    const detectedNeoForge = status.versions.installed;
    if (detectedNeoForge && detectedNeoForge !== mc.neoforge_version) {
      issues.push({
        code: 'NEOFORGE_VERSION_MISMATCH',
        severity: 'warn',
        message: `NeoForge ${detectedNeoForge} is installed but ${mc.neoforge_version} is configured.`,
        hint: 'Either set [minecraft].neoforge_version to the installed version, or re-run the installation for the configured version.',
      });
    }
    if (!status.eulaAccepted) {
      issues.push({
        code: 'EULA_NOT_ACCEPTED',
        severity: 'error',
        message: 'The Minecraft EULA has not been accepted (eula.txt).',
        hint: 'Open the Install / Repair section, read https://aka.ms/MinecraftEULA and accept it. Without it the server exits immediately.',
      });
    }
    if (!status.steps.serverProperties) {
      issues.push({ code: 'SERVER_PROPERTIES_MISSING', severity: 'warn', message: 'server.properties is missing.', hint: 'The server will create it on first start, or press "Write server.properties" in Settings.' });
    }
    if (checkPort && !this.isRunning()) {
      const free = await isPortFree(mc.port, '0.0.0.0');
      if (!free) {
        const minecraftThere = await canConnect(mc.port, '127.0.0.1');
        issues.push({
          code: 'PORT_IN_USE',
          severity: 'error',
          message: `Port ${mc.port} is already in use by another program${minecraftThere ? ' (something is listening on 127.0.0.1:' + mc.port + ')' : ''}.`,
          hint: 'Close the other program (another Minecraft server?) or change [minecraft].port in the configuration.',
        });
      }
    }
    const blockers = issues.filter((i) => i.severity === 'error');
    return { ok: blockers.length === 0, issues, blockers, java, installStatus: status };
  }

  /** Command line used to launch the server (same as the NeoForge run script). */
  async buildCommand({ javaPath }) {
    const mc = this.config.values.minecraft;
    const args = [];
    const jvmArgsFile = path.join(this.config.paths.serverDir, 'user_jvm_args.txt');
    // Java's @argfile syntax tokenizes whitespace before opening the file.
    // Passing an absolute Windows path (the project folder commonly contains
    // spaces) can therefore split the filename and make `nogui` look like the
    // main class. These argfiles are inside serverDir, which is also cwd.
    if (await pathExists(jvmArgsFile)) args.push('@user_jvm_args.txt');
    else args.push(`-Xms${mc.min_ram_mb}M`, `-Xmx${mc.max_ram_mb}M`);

    const runScript = await this.install.readRunScript();
    const expected = neoforgeArgsFile(this.config.paths.serverDir, mc.neoforge_version);
    let argsFile = null;
    if (runScript?.argsFile && (await pathExists(path.join(this.config.paths.serverDir, runScript.argsFile)))) {
      argsFile = path.join(this.config.paths.serverDir, runScript.argsFile);
    } else if (await pathExists(path.join(this.config.paths.serverDir, expected.relative))) {
      argsFile = path.join(this.config.paths.serverDir, expected.relative);
    }
    if (!argsFile) {
      throw new AppError('NeoForge launch arguments were not found - the server is not properly installed.', {
        code: 'NEOFORGE_MISSING',
        status: 409,
        hint: `Expected ${expected.relative} (or run.sh/run.bat) inside ${this.config.paths.serverDir}. Run the installation from the panel.`,
      });
    }
    args.push(`@${path.relative(this.config.paths.serverDir, argsFile)}`, 'nogui', ...(mc.server_args || []));
    return { command: javaPath, args, argsFile, cwd: this.config.paths.serverDir };
  }

  async startServer({ skipPreflight = false, reason = 'panel' } = {}) {
    if (this.isRunning()) throw new ConflictError('The Minecraft server is already running.', { code: 'ALREADY_RUNNING' });
    if (this.state === STATES.STARTING) throw new ConflictError('The Minecraft server is already starting.', { code: 'ALREADY_STARTING' });

    const preflight = skipPreflight ? { ok: true, issues: [], java: await this.java.detect() } : await this.preflight();
    this.warnings = preflight.issues.filter((i) => i.severity !== 'error');
    if (!preflight.ok && !skipPreflight) {
      const blocker = preflight.blockers[0];
      this.setState(STATES.ERROR, { reason: `start blocked: ${blocker.code}`, error: { ...blocker, at: new Date().toISOString() } });
      throw new AppError(blocker.message, { code: blocker.code, status: 409, hint: blocker.hint, details: { issues: preflight.issues } });
    }

    const javaPath = preflight.java?.path;
    if (!javaPath) {
      const detection = await this.java.requireUsable();
      preflight.java = detection;
    }
    const cmd = await this.buildCommand({ javaPath: preflight.java.path });

    // make sure the world/config folders exist
    await this.install.ensureLayout();
    this.parser.reset();
    this.slowStart = false;
    this.lastExit = null;
    this.startAttempts += 1;
    this.setState(STATES.STARTING, { reason });
    this.console.append(`Starting Minecraft ${this.config.values.minecraft.version} with NeoForge ${this.config.values.minecraft.neoforge_version} (java: ${preflight.java.path})`, { stream: 'system' });

    let child;
    try {
      child = spawnProcess(cmd.command, cmd.args, { cwd: cmd.cwd });
    } catch (err) {
      const error = { code: 'START_FAILED', message: `Could not start Java: ${err.message}`, hint: 'Check [minecraft].java_path.' };
      this.setState(STATES.ERROR, { reason: 'spawn failed', error });
      throw new AppError(error.message, { code: error.code, status: 500, hint: error.hint, cause: err });
    }

    this.child = child;
    this.pid = child.pid;
    this.startedAt = new Date();
    this.stoppedAt = null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onOutput(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => this.onOutput(chunk, 'stderr'));
    child.on('error', (err) => {
      this.console.append(`Process error: ${err.message}`, { stream: 'stderr' });
      this.setState(STATES.ERROR, { error: { code: 'PROCESS_ERROR', message: err.message, hint: 'The Java process could not be controlled by the panel.' } });
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));

    this.startMetrics();
    this.startStartupWatchdog();
    this.log.info(`Minecraft server started (pid ${this.pid}, reason: ${reason}).`);
    return this.status();
  }

  /** Warn (do not kill) when a start takes unusually long. */
  startStartupWatchdog() {
    clearTimeout(this._watchdog);
    const limit = this.config.values.minecraft.start_timeout_s * 1000;
    this._watchdog = setTimeout(() => {
      if (this.state !== STATES.STARTING) return;
      this.slowStart = true;
      const hint = 'A modded server can take several minutes to boot. If it never reaches "Done", read the console output: a broken mod is the usual cause.';
      this.console.append(`The server has been starting for more than ${Math.round(limit / 60000)} minute(s).`, { stream: 'system', level: 'WARN' });
      this.events?.publish('status', { state: this.state, slowStart: true, message: `The server is taking longer than ${Math.round(limit / 60000)} minute(s) to start.`, hint, snapshot: this.status() });
    }, limit);
  }

  onOutput(chunk, stream) {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const prefix = /\[([^\]]+)\/(INFO|WARN|ERROR|FATAL)\]:/.exec(line);
      this.console.append(line, { stream, level: prefix ? prefix[2] : null });
      try {
        this.parser.feed(line);
      } catch (err) {
        this.log.debug(`Log parser error: ${err.message}`);
      }
    }
  }

  onParserEvent(event) {
    switch (event.type) {
      case 'online': {
        this.slowStart = false;
        clearTimeout(this._watchdog);
        this.setState(STATES.ONLINE, { reason: 'server reported Done' });
        this.console.append(`Server is online${event.seconds ? ` (started in ${event.seconds}s)` : ''}.`, { stream: 'system' });
        this.emitMetrics();
        break;
      }
      case 'starting':
      case 'preparing':
        break;
      case 'stopping':
        if (this.state === STATES.ONLINE || this.state === STATES.STARTING) this.setState(STATES.STOPPING, { reason: 'stop requested' });
        break;
      case 'joined':
        this.players?.recordJoin(event.player);
        this.events?.publish('players', { action: 'join', player: event.player, players: this.playerList() });
        this.emitMetrics();
        break;
      case 'left':
        this.players?.recordLeave(event.player);
        this.events?.publish('players', { action: 'leave', player: event.player, reason: event.reason, players: this.playerList() });
        this.emitMetrics();
        break;
      case 'list':
        this.events?.publish('players', { action: 'list', players: this.playerList(), max: event.max });
        this.emitMetrics();
        break;
      case 'performance': {
        const metrics = { measuredAt: new Date().toISOString() };
        for (const key of ['mspt', 'p50', 'min', 'max', 'tps', 'source']) {
          if (event[key] !== undefined) metrics[key] = event[key];
        }
        if (metrics.mspt && !metrics.tps) metrics.tps = Math.min(20, Math.round((1000 / metrics.mspt) * 10) / 10);
        this.lastMetrics = { ...(this.lastMetrics || {}), ...metrics };
        this.emitMetrics();
        break;
      }
      case 'version':
        this.events?.publish('status', { state: this.state, versions: { neoforge: event.neoforge, minecraft: this.parser.minecraftVersion } });
        break;
      case 'error':
        this.log.error(`Minecraft reported a failure: ${event.error.message}`, { code: event.error.code });
        this.setState(STATES.ERROR, { reason: event.error.code, error: event.error });
        break;
      default:
        break;
    }
  }

  onExit(code, signal) {
    this.clearTimers();
    const wasOnline = this.state === STATES.ONLINE || this.state === STATES.STARTING || this.state === STATES.STOPPING;
    const intentional = this.state === STATES.STOPPING || this._expectingExit;
    this._expectingExit = false;
    const uptimeS = this.startedAt ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : null;
    this.lastExit = { code, signal, at: new Date().toISOString(), uptimeS, intentional };
    this.child = null;
    this.pid = null;
    this.stoppedAt = new Date();
    this.console.append(`Server process exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`, { stream: 'system' });

    if (intentional || code === 0) {
      this.lastError = null;
      this.setState(STATES.STOPPED, { reason: 'process exited' });
    } else {
      const diagnosis = this.parser.lastError || this.diagnoseExit(code, signal);
      this.setState(STATES.ERROR, { reason: `unexpected exit (code ${code})`, error: { ...diagnosis, at: new Date().toISOString() } });
    }
    for (const resolve of this.exitWaiters) resolve(this.lastExit);
    this.exitWaiters = [];

    if (this.restarting) {
      this.restarting = false;
      this.console.append('Restart requested: starting the server again...', { stream: 'system' });
      // small delay so the OS releases the port and file locks
      setTimeout(() => {
        this.startServer({ reason: 'restart', skipPreflight: false }).catch((err) => {
          this.log.error(`Restart failed: ${err.message}`);
          this.setState(STATES.ERROR, { reason: 'restart failed', error: { code: err.code || 'RESTART_FAILED', message: err.message, hint: err.hint } });
        });
      }, 2500);
    }
  }

  /** Turn an exit code into an explanation, never a bare "Error". */
  diagnoseExit(code, signal) {
    if (signal === 'SIGKILL') {
      return { code: 'PROCESS_KILLED', message: 'The server process was killed (out of memory killer, task manager or a forced stop).', hint: 'Check the system memory and try again with a lower [minecraft].max_ram_mb if the machine is short on RAM.' };
    }
    if (code === 1) return { code: 'STARTUP_FAILURE', message: 'The server exited with code 1 while starting.', hint: 'Read the console output above: missing/incompatible mods, a wrong Java version or an unaccepted EULA are the usual causes.' };
    if (code === 137) return { code: 'PROCESS_KILLED', message: 'The server was killed by the operating system (usually out of memory).', hint: 'Reduce [minecraft].max_ram_mb or close other programs.' };
    if (code === 0) return { code: 'CLEAN_EXIT', message: 'The server stopped normally.' };
    return { code: 'UNEXPECTED_EXIT', message: `The server exited unexpectedly with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`, hint: 'Open the Console page and read the last lines, or check minecraft/server/crash-reports.' };
  }

  // ------------------------------------------------------------------ stop

  /**
   * Ask the server to stop gracefully (console `stop`), then wait for the exit.
   * Never kills unless the user asked for it or the timeout expires.
   */
  async requestStop({ reason = 'panel request', timeoutMs = null, force = false } = {}) {
    if (!this.isRunning()) {
      return { stopped: true, alreadyStopped: true };
    }
    if (this.stopPromise) return this.stopPromise;
    const timeout = timeoutMs ?? this.config.values.minecraft.shutdown_timeout_s * 1000;
    this.setState(STATES.STOPPING, { reason });
    this.console.append('Sending "stop" to the server console...', { stream: 'system' });
    try {
      this.writeLine('stop');
    } catch (err) {
      this.log.error(`Could not write to the server console: ${err.message}`);
    }
    this.stopPromise = new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.console.append(`The server did not stop within ${Math.round(timeout / 1000)}s.`, { stream: 'system', level: 'WARN' });
        if (force) {
          await this.kill({ reason: 'stop timeout' });
          resolve({ stopped: true, forced: true });
        } else {
          resolve({
            stopped: false,
            message: `The server is still stopping after ${Math.round(timeout / 1000)} seconds.`,
            hint: 'It may be saving a large world. Wait a little longer, or use KILL to terminate it immediately (the world will not be saved).',
          });
        }
      }, timeout);
      this.exitWaiters.push((exit) => {
        clearTimeout(timer);
        resolve({ stopped: true, exit });
      });
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  /** Force kill (confirmed by the UI). Data written since the last save is lost. */
  async kill({ reason = 'kill requested' } = {}) {
    if (!this.isRunning()) return { killed: false, alreadyStopped: true };
    this._expectingExit = true;
    this.console.append(`Force killing the server (${reason})...`, { stream: 'system', level: 'WARN' });
    this.setState(STATES.STOPPING, { reason: `kill: ${reason}` });
    const pid = this.pid;
    await terminateProcess(this.child, { graceMs: 8000, signal: 'SIGKILL' });
    this.clearTimers();
    this.log.warn(`Server process ${pid} was killed.`);
    return { killed: true, pid };
  }

  async restart({ reason = 'panel restart' } = {}) {
    if (!this.isRunning()) {
      return this.startServer({ reason: `${reason} (was stopped)` });
    }
    this.restarting = true;
    const result = await this.requestStop({ reason, force: true });
    if (!result.stopped) {
      this.restarting = false;
      throw new AppError(result.message, { code: 'STOP_TIMEOUT', status: 409, hint: result.hint });
    }
    // onExit triggers the start when `restarting` is set
    return { restarting: true };
  }

  clearTimers() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    if (this._watchdog) clearTimeout(this._watchdog);
    this.metricsTimer = null;
    this.keepAliveTimer = null;
    this._watchdog = null;
  }

  // ------------------------------------------------------------------ input

  /**
   * Send one command to the Minecraft console. Validation happens here: no new
   * lines (which could inject several commands), length limited, no control
   * characters. The command is never evaluated by a shell.
   */
  writeLine(command) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed || stdinIsGone(this.child)) {
      throw new AppError('The server console is not available (the server is not running).', { code: 'SERVER_NOT_RUNNING', status: 409 });
    }
    // The callback is what keeps a dying JVM from becoming an uncaught exception; the
    // state is reported as a warning because the console really is closing.
    this.child.stdin.write(`${command}\n`, (err) => {
      if (err) this.log.warn(`The server console closed before the command was written (${err.code || err.message}).`);
    });
    return true;
  }

  sendCommand(rawCommand, { echo = true } = {}) {
    if (typeof rawCommand !== 'string') throw new AppError('The command must be a string.', { code: 'VALIDATION_ERROR', status: 400 });
    const command = rawCommand.replace(/^\//, '').trim();
    if (!command) throw new AppError('The command is empty.', { code: 'VALIDATION_ERROR', status: 400 });
    if (command.length > MAX_COMMAND_LENGTH) throw new AppError(`Commands are limited to ${MAX_COMMAND_LENGTH} characters.`, { code: 'VALIDATION_ERROR', status: 400 });
    if (/[\r\n\0]/.test(command)) throw new AppError('Commands must not contain line breaks.', { code: 'VALIDATION_ERROR', status: 400 });
    if (!this.isRunning()) throw new AppError('The server is not running, so no command can be sent.', { code: 'SERVER_NOT_RUNNING', status: 409, hint: 'Start the server first.' });
    if (echo) this.console.append(command, { stream: 'input' });
    this.writeLine(command);
    this.commandHistory.push({ command, at: new Date().toISOString() });
    if (this.commandHistory.length > 100) this.commandHistory.shift();
    return { sent: true, command };
  }

  // ----------------------------------------------------------------- metrics

  startMetrics() {
    this.clearTimers();
    const intervalMs = 3000;
    this.metricsTimer = setInterval(() => this.emitMetrics().catch(() => {}), intervalMs);
    // Periodic `list` keeps the player count truthful (join/leave lines can be missed).
    this.keepAliveTimer = setInterval(() => {
      if (this.state !== STATES.ONLINE) return;
      try {
        this.writeLine('list');
        if (this.config.values.minecraft.query_tps !== false) this.writeLine('tick query');
      } catch {
        /* the process is going away */
      }
    }, 60000);
    this.emitMetrics().catch(() => {});
  }

  async emitMetrics() {
    const stats = this.isRunning() ? await getProcessStats(this.pid) : { rssMb: null, cpuPercent: null, source: 'none' };
    const parsed = this.parser.snapshot();
    const players = this.playerList();
    const snapshot = {
      at: new Date().toISOString(),
      state: this.state,
      online: this.state === STATES.ONLINE,
      pid: this.pid,
      uptimeS: this.startedAt && this.isRunning() ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      ram: {
        usedMb: stats.rssMb,
        maxMb: this.config.values.minecraft.max_ram_mb,
        minMb: this.config.values.minecraft.min_ram_mb,
        percent: stats.rssMb ? Math.round((stats.rssMb / this.config.values.minecraft.max_ram_mb) * 100) : null,
        source: stats.source,
      },
      cpu: { percent: stats.cpuPercent },
      tps: this.lastMetrics?.tps ?? parsed.tps ?? null,
      mspt: this.lastMetrics?.msptAvg ?? parsed.mspt ?? null,
      players: { online: players.length, max: parsed.maxPlayers ?? this.maxPlayersFallback(), list: players },
      slowStart: this.slowStart,
    };
    this.lastMetrics = { ...(this.lastMetrics || {}), ...snapshot };
    this.events?.publish('metrics', snapshot);
    return snapshot;
  }

  /**
   * `max-players` from server.properties, used until the log reports a real
   * player list (the vanilla log only contains the count when `/list` runs).
   * The file is tiny and the result is cached until it changes.
   */
  maxPlayersFallback() {
    const file = path.join(this.config.paths.serverDir, 'server.properties');
    try {
      const stat = fs.statSync(file);
      if (this._maxPlayersCache && this._maxPlayersCache.mtimeMs === stat.mtimeMs) return this._maxPlayersCache.value;
      const match = /^max-players\s*=\s*(\d+)\s*$/m.exec(fs.readFileSync(file, 'utf8'));
      const value = match ? Number(match[1]) : null;
      this._maxPlayersCache = { mtimeMs: stat.mtimeMs, value };
      return value;
    } catch {
      return null;
    }
  }

  playerList() {
    const fromParser = this.parser.snapshot().players;
    if (fromParser.length) return fromParser;
    if (this.players) return this.players.currentlyOnline();
    return [];
  }

  // ------------------------------------------------------------------ status

  status() {
    const parsed = this.parser.snapshot();
    const mc = this.config.values.minecraft;
    return {
      state: this.state,
      online: this.state === STATES.ONLINE,
      running: this.isRunning(),
      pid: this.pid,
      version: parsed.minecraftVersion || mc.version,
      configured: { minecraft: mc.version, neoforge: mc.neoforge_version },
      neoforge: parsed.neoforgeVersion || null,
      port: mc.port,
      startedAt: this.startedAt?.toISOString() || null,
      uptimeS: this.startedAt && this.isRunning() ? Math.round((Date.now() - this.startedAt.getTime()) / 1000) : 0,
      players: { online: this.playerList().length, max: parsed.maxPlayers ?? this.maxPlayersFallback(), list: this.playerList() },
      tps: this.lastMetrics?.tps ?? parsed.tps ?? null,
      mspt: this.lastMetrics?.msptAvg ?? parsed.mspt ?? null,
      ram: this.lastMetrics?.ram ?? { usedMb: null, maxMb: mc.max_ram_mb, percent: null },
      cpu: this.lastMetrics?.cpu ?? { percent: null },
      lastError: this.lastError,
      lastExit: this.lastExit,
      slowStart: this.slowStart,
      warnings: this.warnings,
      pendingRestart: this.pendingRestart,
      console: this.console.stats(),
      commandHistory: this.commandHistory.slice(-20),
    };
  }
}
