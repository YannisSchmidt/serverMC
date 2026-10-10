#!/usr/bin/env node
/**
 * Command line interface - the same services the panel uses.
 *
 *   node api/cli.js doctor                 check the whole installation
 *   node api/cli.js status                 print the current state
 *   node api/cli.js install [--eula]       install Minecraft + NeoForge + e4mc
 *   node api/cli.js start|stop|restart|kill
 *   node api/cli.js backup [--label x]     create a backup
 *   node api/cli.js backups                list backups
 *   node api/cli.js restore <name> [--restart]
 *   node api/cli.js password [--generate]  set/rotate the admin password
 *   node api/cli.js e4mc [--start|--stop]  e4mc relay control
 *   node api/cli.js cloudflare [--test]    Cloudflare tunnel control
 *   node api/cli.js versions               list NeoForge versions for the configured Minecraft version
 *
 * Commands use the same service layer as the HTTP API, so the CLI and the panel
 * can never disagree about what the configuration means.
 */

import path from 'node:path';
import { Application } from './index.js';
import { toAppError } from './util/errors.js';
import { generatePassword } from './auth/AuthService.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1];
        i += 1;
      } else flags[key] = true;
    } else positional.push(arg);
  }
  return { flags, positional };
}

/**
 * Boot the services for one CLI command.
 *
 * CLI commands run with `listen: false`: the panel (`npm start`) is the only
 * process that serves HTTP, so a CLI command never tries to bind the
 * admin/public ports - it works while the panel is already running instead of
 * failing with "port already in use".
 */
async function withServices(handler, { banner = false, listen = false } = {}) {
  const app = new Application({ argv: ['--no-banner'] });
  await app.boot({ listen });
  if (banner) process.stdout.write(`${await app.banner()}\n`);
  try {
    return await handler(app);
  } finally {
    await app.shutdown({ reason: 'cli command finished' });
  }
}


function out(text = '') {
  process.stdout.write(`${text}\n`);
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${value}%`;
}

/**
 * Is a panel already supervising this server?
 *
 * `start`, `stop`, `restart` and `kill` act on a *process*, and the process
 * belongs to whoever started it. A CLI command boots the services without
 * listening, so it owns no server unless it started one itself: acting anyway
 * would either double-start Minecraft on a taken port, or report success about a
 * server it never touched. Reporting "stopped cleanly" while the panel's server
 * keeps running is worse than refusing, so we ask the panel first.
 *
 * The probe is a plain GET on the admin endpoint. 401 is a fine answer - it means
 * "here, but you need credentials" - but *any* answer is not enough: a dev server
 * or a proxy squatting on 127.0.0.1:8080 used to make every lifecycle verb refuse
 * to run, and made this suite depend on which port happened to be busy on the
 * machine. So the answer has to look like *this* panel: an authentication challenge
 * on that exact route, or our own status shape. The unauthenticated public status
 * endpoint is then asked for the real state, because that is the only one this
 * command may read without a password.
 */
export async function looksLikeThisPanel(answer) {
  if (!answer) return false;
  if (answer.status === 401 || answer.status === 403) return true; // our protected route
  if (!answer.ok) return false;
  const body = await answer.json().catch(() => null);
  return Boolean(body && typeof body === 'object' && (typeof body.state === 'string' || typeof body.server === 'string'));
}

async function panelSupervisor(config) {
  const adminPort = Number(config.values.admin?.port) || 8080;
  const adminBase = `http://127.0.0.1:${adminPort}`;
  const probe = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(600) });
      return res;
    } catch {
      return null;
    }
  };
  const answer = await probe(`${adminBase}/api/admin/status`);
  if (!(await looksLikeThisPanel(answer))) return { listening: false, adminPort, state: null };
  let state = null;
  if (config.values.public?.enabled !== false) {
    const publicPort = Number(config.values.public?.port) || 8081;
    const status = await probe(`http://127.0.0.1:${publicPort}/api/public/status`);
    if (status?.ok) state = await status.json().catch(() => null);
  }
  return { listening: true, adminPort, state };
}

/**
 * A rotated password only reaches the process that wrote it. `config/auth.json` is read at boot, so a panel
 * that is already running keeps authenticating with the credential it loaded - which is how a documented
 * `node api/cli.js password` turns into "wrong password" in the browser until the next restart. The CLI says
 * it instead of letting the user discover it, and points at the path that does work live.
 */
export function passwordSupervisionNote(supervisor) {
  if (!supervisor || !supervisor.listening) return null;
  return [
    `       note: a panel is listening on http://127.0.0.1:${supervisor.adminPort} and still authenticates with`,
    '             the credential it read when it started. Restart that panel, or change the password',
    '             from Settings -> Security in the browser, otherwise the new one is refused until then.',
  ].join('\n');
}

/** The sentence a lifecycle verb prints instead of lying. */
function supervisedMessage(verb, supervisor) {
  const seen = supervisor.state?.state
    ? `The panel reports the server as ${String(supervisor.state.state).toUpperCase()}.`
    : 'The public status page did not answer, so the current state is unknown from here.';
  return [
    `[FAIL] "node api/cli.js ${verb}" was refused: a panel is listening on http://127.0.0.1:${supervisor.adminPort}.`,
    '       That panel owns the Minecraft process, and this command owns none -',
    `       ${seen}`,
    '       -> Start or stop it from the panel (Dashboard), let a player use the',
    '          wake-up code on the public page, or stop the panel first and then',
    '          run this command.',
  ].join('\n');
}

export const COMMANDS = {
  async doctor(app, { flags = {} } = {}) {
    const result = await app.services.doctor.run({ includeNetwork: true });
    // Human report by default, machine readable with --json.
    out(flags.json || flags.format === 'json' ? JSON.stringify(result, null, 2) : app.services.doctor.format(result));
    return result.healthy ? 0 : 1;
  },

  /**
   * Discord: send a real test message through the configured webhook.
   * A failure explains itself (bad URL, deleted webhook, no internet).
   */
  async discordTest(app) {
    const result = await app.services.discord.sendTest();
    out(`[OK] ${result.message}`);
    return 0;
  },

  /** The restart schedule: what is armed, and when it fires next. */
  async restartSchedule(app) {
    const status = app.services.restartScheduler.status();
    out('==================================================');
    out(' Scheduled restarts');
    out('==================================================');
    out(` Enabled     : ${status.enabled ? 'yes' : 'no'}`);
    out(` Times       : ${status.times.length ? status.times.join(', ') : 'none configured'}`);
    out(` Warnings    : ${status.warnMinutes.join(', ')} minute(s) before`);
    out(` Backup first: ${status.autoBackup ? 'yes' : 'no'}`);
    out(` Server      : ${status.serverRunning ? 'running' : 'stopped'}`);
    if (status.next) out(` Next        : ${status.next.time} (in ${Math.max(0, Math.round(status.next.inMs / 60000))} minute(s))`);
    if (status.history.length) {
      out(' History     :');
      for (const item of status.history.slice(-5)) out(`   ${item.at} ${item.time} -> ${item.state}${item.error ? ` (${item.error})` : ''}`);
    }
    out('==================================================');
    return 0;
  },

  /** The MSPT monitor: thresholds, current state, recent samples. */
  async monitorStatus(app) {
    const status = app.services.healthMonitor.status();
    out('==================================================');
    out(' MSPT monitor');
    out('==================================================');
    out(` Threshold   : ${status.thresholdMs} ms per tick sustained for ${status.sustainMin} minute(s)`);
    out(` Cooldown    : one alert every ${status.cooldownMin} minute(s) at most`);
    out(` State       : ${status.state}`);
    out(` Current     : ${status.mspt ?? 'no sample yet'} ms per tick${status.tps ? ` (${status.tps} TPS)` : ''}`);
    out(` Samples     : ${status.windowSamples} in the window, ${status.samples} kept`);
    if (status.recent.length) {
      out(' Recent      :');
      for (const sample of status.recent.slice(-8)) out(`   ${sample.at} ${sample.mspt} ms (${sample.tps ?? '?'} TPS)`);
    }
    out('==================================================');
    return 0;
  },

  async status(app) {
    const mc = app.services.minecraft.status();
    const e4mc = await app.services.e4mc.runtimeStatus();
    const cf = await app.services.cloudflare.status();
    const install = await app.services.install.status();
    const java = await app.services.java.detect();
    const players = await app.services.players.knownPlayers();
    // What a running panel sees, if there is one: this process owns no server, so
    // without this note `status` would report STOPPED next to a live game.
    const supervisor = await panelSupervisor(app.config);
    out('==================================================');
    out(` Minecraft ${app.config.values.minecraft.version} / NeoForge ${app.config.values.minecraft.neoforge_version}`);
    out('==================================================');
    out(` Server        : ${mc.state.toUpperCase()}${mc.pid ? ` (pid ${mc.pid}, uptime ${mc.uptimeS}s)` : ''}`);
    if (supervisor.listening) {
      const seen = supervisor.state;
      out('                 this CLI process supervises nothing: the panel on');
      out(`                 http://127.0.0.1:${supervisor.adminPort} reports ${seen ? `${String(seen.state).toUpperCase()} (${seen.players?.online ?? 0} player(s)${seen.e4mc?.address ? `, ${seen.e4mc.address}` : ', no e4mc address yet'})` : 'a running panel, but its status page did not answer'}.`);
      out('                 Use the Dashboard (or `node api/cli.js doctor`) to act on it.');
    }
    out(` Players       : ${mc.players.online}${mc.players.max ? ` / ${mc.players.max}` : ''}${players.counts.known ? ` (${players.counts.known} known)` : ''}`);
    out(` TPS / MSPT    : ${mc.tps ?? 'n/a'} / ${mc.mspt ?? 'n/a'}`);
    out(` RAM           : ${mc.ram.usedMb ? `${mc.ram.usedMb} MB` : 'n/a'} (max ${mc.ram.maxMb} MB)`);
    out(` CPU           : ${pct(mc.cpu.percent)}`);
    out(` Java          : ${java.found ? `${java.version.feature} (${java.path})` : 'not found'}`);
    out(` Installed     : ${install.ready ? 'ready' : install.installed ? 'incomplete' : 'not installed'}`);
    out(` e4mc          : ${e4mc.state.toUpperCase()}${e4mc.address ? ` - ${e4mc.address}` : ''}`);
    const monitor = app.services.healthMonitor.status();
    out(` MSPT monitor  : ${monitor.state === 'alerting' ? `ALERT (${monitor.mspt} ms per tick)` : `ok (${monitor.mspt ?? 'no sample'} ms per tick)`}`);
    const nextRestart = app.services.restartScheduler.status().next;
    out(` Restart plan  : ${app.config.values.restart.enabled ? (nextRestart ? nextRestart.time : 'none') : 'disabled'}`);
    out(` Discord       : ${app.services.discord.enabled ? `enabled (${app.services.discord.stats.sent} sent)` : 'disabled'}`);
    out(` Cloudflare    : ${cf.enabled ? `${cf.state.toUpperCase()}${cf.url ? ` - ${cf.url}` : ''}` : 'disabled'}`);
    out(` Admin panel   : ${app.adminApp.address}`);
    out(` Public page   : ${app.config.values.public.enabled ? app.publicApp.address : 'disabled'}`);
    out('==================================================');
    return 0;
  },

  async install(app, { flags = {}, positional = [] } = {}) {
    const acceptEula = Boolean(flags.eula || flags.acceptEula);
    const mc = app.config.values.minecraft;
    out(`Installing Minecraft ${mc.version} + NeoForge ${mc.neoforge_version} into ${app.config.paths.serverDir}`);
    if (!acceptEula) {
      out('The Minecraft EULA (https://aka.ms/MinecraftEULA) must be accepted to run the server.');
      out('Re-run with --eula to accept it, or accept it later from the panel.');
    }
    let activePhase = 'install';
    let lastProgressAt = 0;
    const result = await app.services.install.install({
      acceptEula,
      onProgress: (progress = {}) => {
        const { phase, message, received, total } = progress;
        if (phase) activePhase = phase;
        if (message) {
          out(`  [${activePhase}] ${message}`);
          lastProgressAt = Date.now();
          return;
        }
        if (!Number.isFinite(received) || received < 0) return;
        const now = Date.now();
        const complete = Number.isFinite(total) && total > 0 && received >= total;
        if (!complete && now - lastProgressAt < 1000) return;
        const mib = (value) => `${(value / (1024 * 1024)).toFixed(1)} MiB`;
        const detail = Number.isFinite(total) && total > 0
          ? `${mib(received)} / ${mib(total)} (${Math.min(100, Math.floor(received / total * 100))}%)`
          : `${mib(received)} downloaded`;
        out(`  [${activePhase}] Download ${detail}`);
        lastProgressAt = now;
      },
    });
    for (const step of result.steps) out(`  ${step.ok ? '[OK]  ' : '[WARN]'} ${step.label}`);
    out(`Installation state: ${result.status.ready ? 'ready to start' : 'incomplete'}`);
    return result.status.ready || result.status.installed ? 0 : 1;
  },

  async start(app) {
    const supervisor = await panelSupervisor(app.config);
    if (supervisor.listening) {
      out(supervisedMessage('start', supervisor));
      return 1;
    }
    const status = await app.services.minecraft.startServer({ reason: 'cli start' });
    out(`Minecraft is ${status.state} (pid ${status.pid}). Follow the log: logs/minecraft.log`);
    out(' This CLI process is the supervisor: keep this window open, or start the');
    out(' panel (`npm start`) and control the server from there.');
    return 0;
  },

  async stop(app, { flags = {} } = {}) {
    const supervisor = await panelSupervisor(app.config);
    if (supervisor.listening) {
      out(supervisedMessage('stop', supervisor));
      return 1;
    }
    const result = await app.services.minecraft.requestStop({ reason: 'cli stop', force: Boolean(flags.force) });
    // "stopped cleanly" would be a lie when there was nothing to stop: say so.
    if (result.alreadyStopped) out('Minecraft was not running in this process, so there was nothing to stop.');
    else out(result.stopped ? 'Minecraft stopped cleanly.' : `Minecraft is still stopping: ${result.message}`);
    return result.stopped ? 0 : 1;
  },

  async restart(app) {
    const supervisor = await panelSupervisor(app.config);
    if (supervisor.listening) {
      out(supervisedMessage('restart', supervisor));
      return 1;
    }
    await app.services.minecraft.restart({ reason: 'cli restart' });
    out('Restart requested; the server will come back automatically.');
    return 0;
  },

  async kill(app) {
    const supervisor = await panelSupervisor(app.config);
    if (supervisor.listening) {
      out(supervisedMessage('kill', supervisor));
      return 1;
    }
    const result = await app.services.minecraft.kill({ reason: 'cli kill' });
    out(result.killed ? 'Minecraft was killed.' : 'Minecraft is not running in this process.');
    return 0;
  },

  async backup(app, { flags = {}, positional = [] } = {}) {
    const result = await app.services.backups.create({ label: flags.label || '', reason: 'cli backup' });
    out(`Backup created: ${result.name} (${result.files} files, ${result.sizeHuman})`);
    return 0;
  },

  async backups(app) {
    const { backups, usage } = await app.services.backups.list().then(async (list) => ({ backups: list.backups, usage: await app.services.backups.usage() }));
    out(`Backups in ${usage.dir} (${usage.human}):`);
    if (!backups.length) out('  (none yet)');
    for (const backup of backups) out(`  ${backup.name}  ${backup.sizeHuman}  ${backup.createdAt}`);
    return 0;
  },

  async restore(app, { flags = {}, positional = [] } = {}) {
    const name = positional[1];
    if (!name) {
      out('Usage: node api/cli.js restore <backup.zip> [--restart]');
      return 2;
    }
    const result = await app.services.backups.restore(name, {
      confirm: true,
      restartAfter: Boolean(flags.restart),
    });
    out(`Restored ${result.restored.files} files from ${name}${result.safetyBackup ? ` (safety backup: ${result.safetyBackup})` : ''}.`);
    if (result.restarted) out('The server was restarted.');
    return 0;
  },

  async password(app, { flags = {}, positional = [] } = {}) {
    const next = process.env.MCPANEL_ADMIN_PASSWORD || flags.password || (positional[1] ? positional[1] : null);
    const password = next || generatePassword(20);
    const username = flags.username || app.services.auth.account?.username || 'admin';
    await app.services.auth.setPassword(password, { username });
    out('Admin password updated.');
    if (username !== 'admin') out(`Admin username: ${username}.`);
    const note = passwordSupervisionNote(await panelSupervisor(app.config));
    if (note) out(note);
    if (!next) {
      out(`Generated password: ${password}`);
      out('Store it somewhere safe and change it in the panel if needed.');
    }
    return 0;
  },

  async e4mc(app, { flags = {}, positional = [] } = {}) {
    if (flags.stop) {
      await app.services.e4mc.stopRelay({ reason: 'cli' });
      out('e4mc relay stopped.');
      return 0;
    }
    if (flags.start || flags.restart) {
      if (flags.restart) await app.services.e4mc.stopRelay({ reason: 'cli restart' }).catch(() => {});
      const result = await app.services.e4mc.startRelay({ reason: 'cli' });
      const deadline = Date.now() + 30000;
      let status = await app.services.e4mc.runtimeStatus();
      while (!status.address && Date.now() < deadline && status.state !== 'error') {
        await new Promise((r) => setTimeout(r, 1000));
        status = await app.services.e4mc.runtimeStatus();
      }
      out(`e4mc: ${status.state}${status.address ? ` - address ${status.address}` : ''}`);
      if (status.error) out(`  ${status.error.message}\n  -> ${status.error.hint}`);
      return status.address ? 0 : 1;
    }
    const status = await app.services.e4mc.runtimeStatus();
    out(`e4mc state    : ${status.state}`);
    out(`Address       : ${status.address || '(not assigned yet)'}`);
    out(`Relay port    : ${status.port}`);
    out(`Client jar    : ${status.jar.present ? status.jar.path : `missing (${status.jar.path})`}`);
    out(`Broker        : ${status.broker}`);
    const broker = await app.services.e4mc.checkBroker();
    out(`Broker reach  : ${broker.ok ? `ok (${broker.ms} ms, relay ${broker.relay?.host})` : `unreachable - ${broker.error}`}`);
    return 0;
  },

  async cloudflare(app, { flags = {}, positional = [] } = {}) {
    if (flags.start) {
      await app.services.cloudflare.startTunnel({ reason: 'cli' });
      out('Cloudflare tunnel starting.');
      return 0;
    }
    if (flags.stop) {
      await app.services.cloudflare.stopTunnel({ reason: 'cli' });
      out('Cloudflare tunnel stopped.');
      return 0;
    }
    if (flags.test) {
      const result = await app.services.cloudflare.test({ writeConfig: Boolean(flags.writeConfig) });
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    const status = await app.services.cloudflare.status();
    out(`Cloudflare    : ${status.enabled ? status.state : 'disabled'}`);
    out(`Public URL    : ${status.url || '(not configured)'}`);
    out(`Tunnel        : ${status.tunnelEnabled ? `${status.tunnelName} -> ${status.service}` : 'disabled'}`);
    out(`cloudflared   : ${status.cloudflared.found ? status.cloudflared.version : 'not found'}`);
    out(`Credentials   : ${status.location.credentialsExist ? status.location.credentialsFile : 'missing'}`);
    out(`API token     : ${status.tokenConfigured ? 'configured (backend only)' : 'not configured'}`);
    for (const note of status.notes) out(`  note: ${note}`);
    return 0;
  },

  async versions(app, { flags = {} } = {}) {
    const result = await app.services.install.availableNeoForgeVersions({ includePrerelease: Boolean(flags.prerelease) });
    out(`NeoForge line for Minecraft ${app.config.values.minecraft.version}: ${result.prefix}x`);
    out(`Latest: ${result.latest || 'unknown'}`);
    out(`Available (${result.versions.length}):`);
    for (const version of result.versions.slice(0, 40)) out(`  ${version}`);
    return 0;
  },

  /**
   * Compile the bundled server-side admin mod (mods-src/admin-tools) and copy
   * the jar into minecraft/server/mods.
   *
   * The build runs the Gradle wrapper through the Java runtime configured for
   * Minecraft, so nothing but `java` is executed. The first run downloads
   * Gradle + the NeoForge artefacts and can take a few minutes.
   */
  async buildMod(app, { flags = {} } = {}) {
    const install = flags['no-install'] ? false : null;
    const status = await app.services.adminMod.status();
    out(`Building admintools ${status.mod.version} (Minecraft ${status.mod.minecraftVersion} / NeoForge ${status.mod.neoForgeVersion})`);
    out(`  sources : ${status.sourceDir}`);
    out(`  java    : ${status.java.found ? `${status.java.feature} (${status.java.path})` : 'not found'}`);
    out('  The first build downloads Gradle and the NeoForge artefacts, this can take a few minutes...');
    const started = Date.now();
    const result = await app.services.adminMod.build({
      reason: 'cli build-mod',
      install,
      onLine: (line) => out(`  | ${line}`),
    });
    out('');
    out(`[OK] ${result.message} (${Math.round((Date.now() - started) / 1000)} s)`);
    if (result.installedPath) out(`     installed: ${result.installedPath}`);
    if (result.restartRequired) out('     Restart the Minecraft server from the panel to load the mod.');
    return 0;
  },

  /**
   * The bridge token used by the in-game /panel command of the admin mod.
   *
   * The token is a secret: it is printed only here, never by an HTTP endpoint,
   * and `--write-mod-config` copies it straight into the mod configuration so
   * it never has to be typed by hand.
   */
  async bridgeToken(app, { flags = {} } = {}) {
    if (flags.rotate) await app.services.bridge.rotate({ createdBy: 'cli bridge-token --rotate' });
    const status = app.services.bridge.status();
    out('Bridge token for the in-game /panel command (loopback only, never sent to the browser):');
    out(`  ${app.services.bridge.token()}`);
    out(`  stored in : ${status.tokenFile}`);
    out(`  mod config: ${status.modConfig.file}`);
    out(`  linked    : ${status.linked ? 'yes (the mod can use the bridge)' : 'no - run with --write-mod-config'}`);
    out(`  used      : ${status.useCount} request(s)${status.lastUsedAt ? `, last at ${status.lastUsedAt}` : ''}`);
    if (flags['write-mod-config'] || flags.writeModConfig) {
      const written = await app.services.bridge.writeModConfig();
      out(`[OK] ${written.message}`);
    } else if (!status.linked) {
      out('  -> node api/cli.js bridge-token --write-mod-config');
    }
    return 0;
  },

  async config(app) {
    out(JSON.stringify(app.config.toPublicJson(), null, 2));
    return 0;
  },

  async help() {
    out('Minecraft Server Manager - CLI');
    out('');
    out('  doctor                     full environment check ([OK]/[WARN]/[FAIL])');
    out('  build-mod [--no-install]   compile the bundled admin mod and install the jar');
    out('  status                     current state of everything');
    out('  install [--eula]           install vanilla + NeoForge + e4mc relay');
    out('  start | stop | restart | kill');
    out('  backup [--label NAME]      create a backup');
    out('  backups                    list backups');
    out('  restore NAME [--restart]   restore a backup (safety backup first)');
    out('  password [--username X]    rotate admin credentials (password from prompt/env or --password)');
    out('  bridge-token [--rotate] [--write-mod-config]');
    out('                             token used by the in-game /panel command');
    out('  discord-test               send a real test message to the Discord webhook');
    out('  restart-schedule           show the scheduled restarts and the next one');
    out('  monitor-status             MSPT monitor: thresholds, state, recent samples');
    out('  e4mc [--start|--stop|--restart]');
    out('  cloudflare [--start|--stop|--test]');
    out('  versions [--prerelease]    NeoForge versions for the configured Minecraft version');
    out('  config                     effective configuration (secrets masked)');
    out('');
    out('  The panel itself: npm start  (or ./start.sh / start.bat)');
    return 0;
  },
};

async function run() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  // `build-mod` and `buildMod` are the same command.
  const command = (positional[0] || 'help').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  if (flags.help || command === 'help' || command === '--help') return COMMANDS.help();

  if (!(command in COMMANDS)) {
    out(`Unknown command "${command}".`);
    await COMMANDS.help();
    return 2;
  }

  // `start` owns Minecraft itself, so its service container must live as long
  // as the server. Other one-shot commands still use withServices().
  if (command === 'start') return runStart({ flags, positional });

  // Every CLI command runs without binding the web ports (see withServices).
  const code = await withServices((app) => COMMANDS[command](app, { flags, positional }), { banner: command === 'status' });
  return code;
}

async function runStart(args) {
  const app = new Application({ argv: ['--no-banner'] });
  await app.boot({ listen: false });
  let code = 1;
  let started = false;
  let shutdownReason = 'cli start finished';
  let resolveSignal;
  const signal = new Promise((resolve) => { resolveSignal = resolve; });
  const onInt = () => resolveSignal('SIGINT');
  const onTerm = () => resolveSignal('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    code = await COMMANDS.start(app, args);
    if (code !== 0) return code;
    started = true;
    // Stay attached to the process we just started. If Minecraft exits by
    // itself, return its terminal state instead of leaving an idle supervisor.
    while (true) {
      const result = await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
        signal,
      ]);
      if (result) {
        shutdownReason = result;
        return result === 'SIGINT' ? 0 : 1;
      }
      const state = String(app.services.minecraft.status().state).toLowerCase();
      if (state === 'stopped' || state === 'error') return state === 'stopped' ? 0 : 1;
    }
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    if (started && String(app.services.minecraft.status().state).toLowerCase() === 'stopped') shutdownReason = 'minecraft stopped';
    await app.shutdown({ reason: shutdownReason });
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('api', 'cli.js'));
if (isDirectRun) {
  run()
    .then((code) => {
      process.exitCode = typeof code === 'number' ? code : 0;
    })
    .catch((err) => {
      const appError = toAppError(err);
      process.stderr.write(`\n[FAIL] ${appError.message}\n`);
      if (appError.hint) process.stderr.write(`       -> ${appError.hint}\n`);
      process.exitCode = 1;
    });
}

export { run, withServices, parseArgs };
