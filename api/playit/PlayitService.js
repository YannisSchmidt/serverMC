/** Manages the official Playit agent for a no-port-forward Minecraft tunnel. */
import path from 'node:path';
import { spawnProcess, terminateProcess, runCommand } from '../util/proc.js';
import { pathExists } from '../util/fsx.js';
import { AppError } from '../util/errors.js';

// Playit for Windows installs the service controller alongside its agent.
const RELEASE = '1.0.10';
const DEFAULT_WINDOWS_CLIENT = 'C:/Program Files/playit_gg/bin/playit.exe';

export class PlayitService {
  constructor({ config, logs, minecraft, events }) {
    this.config = config; this.log = logs.playit; this.minecraft = minecraft; this.events = events;
    this.child = null; this.state = config.values.playit.enabled ? 'stopped' : 'disabled';
    this.claimUrl = null; this.error = null; this.output = []; this.externalRunning = false; this.lastExternalCheck = 0;
  }
  get agentPath() {
    const value = this.config.values.playit.agent_path;
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.config.paths.projectRoot, value);
  }
  get clientPath() {
    const value = this.config.values.playit.client_path || DEFAULT_WINDOWS_CLIENT;
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(this.config.paths.projectRoot, value);
  }
  isRunning() { return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null; }
  status() {
    return { enabled: Boolean(this.config.values.playit.enabled), state: this.config.values.playit.enabled ? this.state : 'disabled',
      running: this.isRunning() || this.externalRunning, managedExternally: process.platform === 'win32',
      address: this.config.values.playit.address || null, claimUrl: this.claimUrl,
      agent: { path: process.platform === 'win32' ? this.clientPath : this.agentPath, present: false, version: RELEASE }, error: this.error, output: this.output.slice(-40) };
  }
  async runtimeStatus() {
    const previousRunning = this.externalRunning;
    const previousState = this.state;
    if (process.platform === 'win32' && Date.now() - this.lastExternalCheck > 5000 && await pathExists(this.clientPath)) {
      this.lastExternalCheck = Date.now();
      try {
        const result = await runCommand(this.clientPath, ['status'], { timeoutMs: 5000 });
        const output = `${result.stdout}\n${result.stderr}`;
        this.externalRunning = /Phase:\s*running/i.test(output);
        if (this.config.values.playit.enabled) this.state = this.externalRunning ? 'online' : (this.isRunning() ? this.state : 'stopped');
      } catch (err) {
        this.externalRunning = false;
        this.error = { message: err.message, hint: 'Vérifie que le service Playit Windows est démarré.' };
      }
    }
    if (previousRunning !== this.externalRunning || previousState !== this.state) this.publish();
    const status = this.status();
    status.agent.present = await pathExists(this.clientPath) || await pathExists(this.agentPath);
    return status;
  }
  publish() { this.events?.publish('playit', this.status()); }
  addOutput(text) {
    const line = String(text || '').trim(); if (!line) return;
    this.output.push(line); if (this.output.length > 200) this.output.splice(0, this.output.length - 200);
    const claim = /https:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/i.exec(line);
    if (claim) this.claimUrl = claim[0];
    const connected = /playit connected; tunnels loaded/i.test(line);
    if (connected) this.state = 'online';
    if (/error|failed/i.test(line)) this.log.warn(line.slice(0, 500)); else this.log.info(line.slice(0, 500));
    this.publish();
  }
  async start() {
    if (!this.config.values.playit.enabled) { this.state = 'disabled'; return this.runtimeStatus(); }
    if (this.isRunning() || this.externalRunning) return this.runtimeStatus();
    if (process.platform === 'win32' && await pathExists(this.clientPath)) {
      this.error = null;
      this.state = 'connecting';
      const result = await runCommand(this.clientPath, ['start'], { timeoutMs: 15_000 });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.code !== 0 || /access denied|failed to start service/i.test(output)) {
        this.state = 'error';
        this.error = { message: output || `Playit service controller exited with code ${result.code}.`, hint: 'Le service Playit Windows exige des droits administrateur. Démarre Playit depuis le menu Démarrer ou lance le panneau en administrateur.' };
        this.publish();
        return this.runtimeStatus();
      }
      this.externalRunning = false;
      this.lastExternalCheck = 0;
      const status = await this.runtimeStatus();
      if (status.running) this.state = 'online';
      this.publish();
      return this.status();
    }
    if (process.platform === 'win32') throw new AppError('Playit for Windows must be installed before starting its service.', {
      code: 'PLAYIT_CLIENT_MISSING', status: 409,
      hint: 'Install the signed Windows application from https://playit.gg/download/windows.',
    });
    if (!(await pathExists(this.agentPath))) throw new AppError('Playit agent is not installed yet.', { code: 'PLAYIT_MISSING', status: 409, hint: 'Use “Install Playit agent” in the admin panel.' });
    this.error = null; this.state = 'connecting'; this.publish();
    const child = spawnProcess(this.agentPath, [], { cwd: path.dirname(this.agentPath) });
    this.child = child;
    const receive = (chunk) => String(chunk).split(/\r?\n/).forEach((line) => this.addOutput(line));
    child.stdout?.on('data', receive); child.stderr?.on('data', receive);
    child.on('error', (err) => { this.error = { message: err.message, hint: 'Vérifie que Windows a autorisé le lancement de playit.exe.' }; this.state = 'error'; this.publish(); });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null; this.state = this.config.values.playit.enabled ? (code === 0 ? 'stopped' : 'error') : 'disabled';
      if (code && code !== 0) this.error = { message: `Playit agent stopped (exit ${code}).`, hint: 'Consulte les dernières lignes de sortie ci-dessous.' };
      this.publish();
    });
    this.log.info(`Starting Playit agent ${RELEASE}...`);
    return this.runtimeStatus();
  }
  async stop() {
    if (process.platform === 'win32' && await pathExists(this.clientPath) && (this.externalRunning || this.isRunning())) {
      const result = await runCommand(this.clientPath, ['stop'], { timeoutMs: 15_000 });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (result.code !== 0 || /access denied|failed to stop service/i.test(output)) {
        this.error = { message: output || `Playit service controller exited with code ${result.code}.`, hint: 'Le service Playit Windows exige des droits administrateur.' };
        this.publish();
        return this.runtimeStatus();
      }
      this.externalRunning = false;
      this.state = this.config.values.playit.enabled ? 'stopped' : 'disabled';
      this.lastExternalCheck = Date.now();
      this.publish();
      return this.runtimeStatus();
    }
    if (!this.isRunning()) return this.runtimeStatus();
    this.state = 'stopping'; this.publish();
    const child = this.child; this.child = null;
    await terminateProcess(child, { graceMs: 5000 }).catch(() => {});
    this.state = this.config.values.playit.enabled ? 'stopped' : 'disabled'; this.publish();
    return this.runtimeStatus();
  }
  async installAgent() {
    if (process.platform === 'win32' && await pathExists(this.clientPath)) return this.runtimeStatus();
    throw new AppError('Install the recommended Playit application for Windows first.', {
      code: 'PLAYIT_CLIENT_MISSING', status: 409,
      hint: 'Download the signed Windows installer from https://playit.gg/download/windows, install it, then set client_path in [playit] if its location differs from the default.',
    });
  }
  async startService() {
    if (!this.config.values.playit.enabled) { this.state = 'disabled'; return this.status(); }
    await this.runtimeStatus().catch((err) => this.log.warn(`Initial Playit status check failed: ${err.message}`));
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.runtimeStatus().catch((err) => this.log.warn(`Playit status check failed: ${err.message}`)), 10_000);
      this.pollTimer.unref?.();
    }
    this.minecraft?.on('state', ({ state }) => {
      if (state === 'online' && this.config.values.playit.enabled && this.config.values.playit.autostart_with_server && !this.isRunning()) this.start().catch((err) => this.log.warn(`Automatic Playit start failed: ${err.message}`));
      if ((state === 'stopped' || state === 'error') && this.isRunning() && this.config.values.playit.autostart_with_server) this.stop().catch(() => {});
    });
    if (this.minecraft?.state === 'online' && this.config.values.playit.autostart_with_server) await this.start().catch((err) => this.log.warn(err.message));
    return this.status();
  }
  async applySettings() {
    if (!this.config.values.playit.enabled) { await this.stop(); this.state = 'disabled'; this.publish(); return this.status(); }
    if (this.config.values.playit.autostart_with_server && this.minecraft?.state === 'online' && !this.isRunning()) await this.start().catch((err) => this.log.warn(err.message));
    return this.status();
  }
}
