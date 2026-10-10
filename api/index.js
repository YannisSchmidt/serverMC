#!/usr/bin/env node
/**
 * Entry point: wires every service together, starts the two web servers and
 * handles graceful shutdown (Minecraft `stop`, e4mc close, tunnel close, HTTP
 * close) - never killing Minecraft unless the user explicitly asked for KILL.
 *
 *   node api/index.js             start the panel (+ Minecraft if auto_start)
 *   node api/index.js --no-banner
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config, PROJECT_ROOT } from './config/config.js';
import { LogManager } from './logging/logger.js';
import { Container } from './core/container.js';
import { EventHub, EVENTS } from './core/events.js';
import { JavaService } from './minecraft/JavaService.js';
import { InstallService } from './minecraft/InstallService.js';
import { MinecraftService } from './minecraft/MinecraftService.js';
import { PlayerService } from './minecraft/PlayerService.js';
import { ModsService } from './minecraft/ModsService.js';
import { AdminModService } from './minecraft/AdminModService.js';
import { DiscordService } from './discord/DiscordService.js';
import { RestartScheduler } from './minecraft/RestartScheduler.js';
import { HealthMonitor } from './minecraft/HealthMonitor.js';
import { E4mcService } from './e4mc/E4mcService.js';
import { CloudflareService } from './cloudflare/CloudflareService.js';
import { PlayitService } from './playit/PlayitService.js';
import { BackupService } from './backup/BackupService.js';
import { FilesService } from './files/FilesService.js';
import { AuthService } from './auth/AuthService.js';
import { BridgeService } from './auth/BridgeService.js';
import { PowerService } from './public/PowerService.js';
import { PublicStatusService } from './public/PublicStatusService.js';
import { DoctorService } from './doctor/DoctorService.js';
import { AdminApp } from './admin/app.js';
import { PublicApp } from './public/app.js';
import { SseHub } from './http/sse.js';
import { toAppError } from './util/errors.js';
import { humanBytes } from './util/fsx.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function buildServices({ config, logs, events, container }) {
  const services = { config, logs, events, container };
  services.java = new JavaService({ config, logs });
  services.install = new InstallService({ config, logs, java: services.java, events });
  services.minecraft = new MinecraftService({
    config, logs, java: services.java, install: services.install, events,
  });
  services.players = new PlayerService({ config, logs, minecraft: services.minecraft, events });
  services.minecraft.players = services.players;
  services.mods = new ModsService({ config, logs, minecraft: services.minecraft, events });
  // Compiles the bundled server-side admin mod (mods-src/admin-tools) with the
  // Gradle wrapper, started through the configured Java runtime.
  services.adminMod = new AdminModService({
    config, logs, events, java: services.java, mods: services.mods, minecraft: services.minecraft,
  });
  services.e4mc = new E4mcService({
    config, logs, minecraft: services.minecraft, events, java: services.java, install: services.install,
  });
  services.cloudflare = new CloudflareService({ config, logs, events });
  services.playit = new PlayitService({ config, logs, minecraft: services.minecraft, events });
  services.files = new FilesService({ config, logs });
  services.backups = new BackupService({ config, logs, minecraft: services.minecraft, events });
  services.auth = new AuthService({ config, logs, events });
  // Local bridge used by the in-game /panel command of the bundled admin mod.
  services.bridge = new BridgeService({ config, logs });
  // The single write route of the public listener: players may wake the server
  // up with a shared code, nothing else (startServer is the panel's own START).
  services.power = new PowerService({ config, logs, minecraft: services.minecraft });
  services.publicStatus = new PublicStatusService({
    config, logs, minecraft: services.minecraft, e4mc: services.e4mc, cloudflare: services.cloudflare, playit: services.playit, events,
  });
  services.doctor = new DoctorService({
    config, logs, java: services.java, install: services.install, minecraft: services.minecraft,
    e4mc: services.e4mc, cloudflare: services.cloudflare, files: services.files, backups: services.backups,
    auth: services.auth, adminMod: services.adminMod, bridge: services.bridge, power: services.power,
  });
  // Discord notifications, scheduled restarts and the MSPT monitor all react to
  // what the other services publish: none of them owns a piece of state that
  // another service would have to know about.
  services.discord = new DiscordService({ config, logs, events });
  services.restartScheduler = new RestartScheduler({
    config, logs, minecraft: services.minecraft, backups: services.backups, events,
  });
  services.healthMonitor = new HealthMonitor({ config, logs, events, minecraft: services.minecraft });
  services.sse = new SseHub({ events });
  services.console = services.minecraft.console;

  // Bridge the Minecraft console into the event hub so SSE clients receive the
  // live output (the Console page renders from this stream).
  services.console.on('line', (entry) => events.publish(EVENTS.CONSOLE, entry));

  // The SSE hub remembers the latest payload of each stream so a freshly
  // opened page renders immediately without extra polling.
  for (const type of [EVENTS.STATUS, EVENTS.METRICS, EVENTS.E4MC, EVENTS.CLOUDFLARE, EVENTS.PLAYERS, EVENTS.JOB, EVENTS.SETTINGS, EVENTS.RESTART, EVENTS.MONITOR_ALERT, 'playit']) {
    events.on(type, (payload) => services.sse.remember(type, payload));
  }
  return services;
}

export class Application {
  constructor({ projectRoot = PROJECT_ROOT, argv = process.argv.slice(2), logToConsole = true } = {}) {
    this.projectRoot = projectRoot;
    this.argv = argv;
    this.logToConsole = logToConsole;
    this.startedAt = Date.now();
    this.shuttingDown = false;
  }

  /**
   * Wire everything up and (by default) start the two listeners.
   * @param {{listen?: boolean}} options `listen: false` is used by the CLI for
   *   read-only commands (doctor/status/...), so they also work while another
   *   panel instance is already serving the ports.
   */
  async boot({ listen = true } = {}) {
    this.config = new Config({ projectRoot: this.projectRoot });
    this.config.start();
    this.logs = new LogManager(this.config, { console: this.logToConsole });
    this.log = this.logs.application.child('core');
    this.events = new EventHub();
    this.container = new Container({ config: this.config, logs: this.logs, events: this.events });
    this.services = buildServices({ config: this.config, logs: this.logs, events: this.events, container: this.container });

    const started = [];
    const startService = async (name, service) => {
      if (typeof service.start !== 'function') return;
      await service.start();
      started.push(name);
    };

    await startService('auth', this.services.auth);
    await startService('bridge', this.services.bridge);
    await startService('publicStatus', this.services.publicStatus);
    await startService('mods', this.services.mods);
    await startService('backups', this.services.backups);
    await startService('minecraft', this.services.minecraft);
    await startService('e4mc', this.services.e4mc);
    await startService('cloudflare', this.services.cloudflare);
    await this.services.playit.startService();
    started.push('playit');
    await startService('discord', this.services.discord);
    await startService('restartScheduler', this.services.restartScheduler);
    await startService('healthMonitor', this.services.healthMonitor);
    this.startedServices = started;
    this.listening = false;
    this.listenError = null;

    this.adminApp = new AdminApp(this.services);
    this.publicApp = new PublicApp(this.services);
    if (!listen) {
      this.listening = false;
      return this;
    }
    await this.adminApp.listen();
    this.listening = true;
    if (this.config.values.public.enabled) {
      await this.publicApp.listen().catch((err) => {
        this.log.error(`The public page could not start: ${err.message} (${err.hint || ''})`);
        this.publicStartError = toAppError(err);
      });
    }

    await this.services.players.ensureDefaultFiles().catch(() => {});
    this.installSignalHandlers();

    if (this.config.values.minecraft.auto_start) {
      this.services.minecraft.startServer({ reason: 'auto start (configuration)' }).catch((err) => {
        this.log.error(`Auto start failed: ${err.message}${err.hint ? ` - ${err.hint}` : ''}`);
      });
    }
    this.events.publish(EVENTS.READY, { at: new Date().toISOString() });
    return this;
  }

  /** Console banner with every useful URL and integration state. */
  async banner() {
    const mc = this.config.values.minecraft;
    const e4mcStatus = await this.services.e4mc.runtimeStatus();
    const cfStatus = await this.services.cloudflare.status();
    const install = await this.services.install.status().catch(() => null);
    const line = '==================================================';
    const out = [];
    out.push(line);
    out.push(' Minecraft Server Manager');
    out.push(' Minecraft ' + mc.version + ' | NeoForge ' + mc.neoforge_version + ' | Java ' + this.config.requiredJava + '+');
    out.push(line);
    out.push('Admin panel    : ' + (this.listening === false
      ? `not bound in this process (configured for ${this.config.values.admin.host}:${this.config.values.admin.port})`
      : this.adminApp.address));
    out.push('Public page    : ' + (this.config.values.public.enabled ? this.publicApp.address : 'disabled in configuration'));
    out.push('Guide          : START.md  (first run, the admin password, the address to share)');
    out.push('Cloudflare     : ' + (cfStatus.enabled ? `${cfStatus.state}${cfStatus.url ? ` (${cfStatus.url})` : ''}` : 'disabled'));
    out.push('Minecraft      : ' + this.services.minecraft.state.toUpperCase() + ` (port ${mc.port})`);
    out.push('e4mc           : ' + e4mcStatus.state.toUpperCase() + (e4mcStatus.address ? ` (${e4mcStatus.address})` : ''));
    out.push('Server files   : ' + (install?.ready ? 'ready' : 'not installed yet - start again and answer YES, or use the panel Install page'));
    const next = this.services.restartScheduler?.status?.().next;
    out.push('Restart plan   : ' + (this.config.values.restart.enabled
      ? (next ? `next at ${next.time} (in ${Math.max(0, Math.round(next.inMs / 60000))} min)` : 'no time configured')
      : 'disabled'));
    out.push('Discord        : ' + (this.services.discord?.enabled
      ? `enabled (${this.services.discord.webhookHost()}, ${this.services.discord.stats.sent} message(s) sent)`
      : (this.config.values.discord.enabled ? 'enabled but the webhook URL is missing' : 'disabled')));
    out.push('MSPT monitor   : ' + (this.services.healthMonitor?.status?.().state === 'alerting'
      ? `ALERT (above ${this.config.values.monitor.mspt_alert_ms} ms per tick)`
      : `ok (alert above ${this.config.values.monitor.mspt_alert_ms} ms per tick)`));
    out.push('Logs           : ' + path.relative(this.projectRoot, this.config.paths.logsDir));
    out.push(line);
    const generated = this.services.auth.takeGeneratedPassword();
    if (generated) {
      out.push(' First run: an admin password was generated for you');
      out.push(' Username : ' + (this.services.auth.account?.username || 'admin'));
      out.push(' Password : ' + generated);
      out.push(' (change it in Settings -> Security; it is not stored in clear text)');
      out.push(line);
    }
    if (!this.services.auth.authEnabled) {
      out.push(' WARNING: admin authentication is DISABLED ([admin].auth_enabled = false)');
      out.push(line);
    }
    if (this.publicStartError) {
      out.push(' WARNING: the public page failed to start: ' + this.publicStartError.message);
      out.push(line);
    }
    for (const warning of this.config.warnings || []) out.push(' note: ' + warning);
    return out.join('\n');
  }

  installSignalHandlers() {
    const handler = (signal) => {
      if (this.shuttingDown) return;
      this.log.info(`Received ${signal}: shutting down cleanly...`);
      this.shutdown({ reason: signal }).then(() => process.exit(0)).catch((err) => {
        this.log.error(`Shutdown error: ${err.message}`);
        process.exit(1);
      });
    };
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('uncaughtException', (err) => {
      this.log.error(`Uncaught exception: ${err.stack || err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
      const appError = toAppError(reason);
      this.log.error(`Unhandled rejection: ${appError.message}`);
    });
  }

  /**
   * Graceful shutdown order (project spec #22):
   *   1. warn the Minecraft server and send `stop`
   *   2. wait for a clean exit
   *   3. close e4mc
   *   4. close the Cloudflare tunnel (only if this program started it)
   *   5. close the HTTP servers
   */
  async shutdown({ reason = 'manual' } = {}) {
    if (this.shuttingDown) return { alreadyShuttingDown: true };
    this.shuttingDown = true;
    const report = { reason, steps: [] };
    const step = async (name, fn) => {
      try {
        const result = await fn();
        report.steps.push({ name, ok: true, result });
      } catch (err) {
        const appError = toAppError(err);
        report.steps.push({ name, ok: false, error: appError.message });
        this.log.warn(`Shutdown step "${name}" failed: ${appError.message}`);
      }
    };

    await step('admin-mod-build', () => this.services.adminMod?.stop());
    await step('restart-scheduler', () => this.services.restartScheduler?.stop());
    await step('health-monitor', () => this.services.healthMonitor?.stop());
    await step('discord', () => this.services.discord?.stop());
    await step('minecraft', () => this.services.minecraft.stop());
    await step('e4mc', () => this.services.e4mc.stop());
    await step('cloudflare', () => this.services.cloudflare.stop());
    await step('playit', () => this.services.playit.stop());
    await step('backups', () => this.services.backups.stop());
    await step('mods', () => this.services.mods.stop());
    await step('auth', () => this.services.auth.stop());
    await step('public-page', () => this.publicApp?.close());
    await step('admin-panel', () => this.adminApp?.close());
    this.log.info(`Shutdown complete (${reason}).`);
    return report;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const app = new Application({ argv });
  try {
    await app.boot();
  } catch (err) {
    const appError = toAppError(err);
    // Boot failures must explain themselves precisely.
    process.stderr.write(`\n[FAIL] ${appError.message}\n`);
    if (appError.hint) process.stderr.write(`       -> ${appError.hint}\n`);
    if (appError.details) process.stderr.write(`       details: ${JSON.stringify(appError.details)}\n`);
    process.exitCode = 1;
    return null;
  }
  if (!argv.includes('--no-banner')) {
    process.stdout.write(`${await app.banner()}\n`);
  }
  return app;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

export { humanBytes, os, HERE };
