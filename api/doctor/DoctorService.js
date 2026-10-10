/**
 * DoctorService - the `doctor` command.
 *
 * Checks Java, Minecraft, NeoForge, RAM, disk, network, e4mc, Cloudflare,
 * permissions and the configuration, and returns [OK]/[WARN]/[FAIL] lines with
 * an explanation and a fix hint for every problem. Nothing here is faked: each
 * check inspects the real machine, configuration or file system.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkInternet, isPortFree, canConnect, fetchJson } from '../util/net.js';
import { statOrNull, humanBytes, ensureDir } from '../util/fsx.js';
import { cpuCount, totalMemoryMb, whichSync } from '../util/proc.js';
import { E4MC_STATES } from '../e4mc/E4mcService.js';

/** Levels are lowercase in the JSON API (the web UI uses them as CSS classes)
 *  and rendered as [OK]/[WARN]/[FAIL] in the terminal output. */
export const LEVELS = { OK: 'ok', WARN: 'warn', FAIL: 'error', INFO: 'info' };
/** Terminal tags for the report. */
const LEVEL_TAGS = { ok: '[OK]  ', warn: '[WARN]', error: '[FAIL]', info: '[INFO]' };

export class DoctorService {
  constructor({
    config, logs, java, install, minecraft, e4mc, cloudflare, files, backups, auth, adminMod = null, bridge = null,
    power = null,
  }) {
    this.config = config;
    this.logs = logs;
    this.java = java;
    this.install = install;
    this.minecraft = minecraft;
    this.e4mcSvc = e4mc;
    this.cloudflare = cloudflare;
    this.files = files;
    this.backups = backups;
    this.auth = auth;
    this.adminModSvc = adminMod;
    this.bridge = bridge;
    this.power = power;
  }

  /** Read the journal the admin mod writes inside the server directory. */
  async readJournal(dir) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return { present: false, files: 0, bytes: 0, human: '0 B', oldest: null };
    }
    const files = entries.filter((entry) => entry.isFile() && /^journal-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name));
    if (!files.length) return { present: false, files: 0, bytes: 0, human: '0 B', oldest: null };
    let bytes = 0;
    for (const file of files) bytes += (await statOrNull(path.join(dir, file.name)))?.size || 0;
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { present: true, files: files.length, bytes, human: humanBytes(bytes), oldest: files[0].name };
  }

  check(id, label, level, message, extra = {}) {
    return { id, label, level, message, ...extra };
  }

  /**
   * Read the data the admin mod keeps in `config/admintools/` of the server
   * directory: the homes/warps/kits of the essentials, the graves and the items
   * still waiting to be claimed, and the blocked words of the chat filter.
   *
   * Read-only and forgiving, like readJournal: the files are tab-separated with
   * a `#` header line (the format the mod writes), and a missing file simply
   * means "nobody used that feature yet" - never an error.
   */
  async readModData(serverDir) {
    const base = path.join(serverDir, 'config', 'admintools');
    const state = {
      present: false, dir: base, homes: 0, warps: 0, kits: 0,
      graves: 0, waiting: 0, words: 0, files: 0, bytes: 0, human: '0 B',
    };

    const countLines = async (file) => {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        return null; // missing or unreadable: nothing to report for this file
      }
      const stat = await statOrNull(file);
      state.present = true;
      state.files += 1;
      if (stat) state.bytes += stat.size;
      return text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).length;
    };

    for (const [key, file] of [
      ['homes', path.join(base, 'essentials', 'homes.txt')],
      ['warps', path.join(base, 'essentials', 'warps.txt')],
      ['kits', path.join(base, 'essentials', 'kits.txt')],
      ['words', path.join(base, 'chatfilter.txt')],
    ]) {
      const count = await countLines(file);
      if (count !== null) state[key] = count;
    }

    const gravesFile = path.join(base, 'graves', 'graves.txt');
    const graves = await countLines(gravesFile);
    if (graves !== null) state.graves = graves;

    // The items a grave could not put in a chest wait in items-<uuid>.txt.
    try {
      const entries = await fsp.readdir(path.join(base, 'graves'), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^items-[0-9a-f-]{36}\.txt$/.test(entry.name)) continue;
        const lines = await countLines(path.join(base, 'graves', entry.name));
        if (lines) state.waiting += lines;
      }
    } catch {
      // no graves directory at all
    }

    state.human = humanBytes(state.bytes);
    return state;
  }

  async run({ includeNetwork = true } = {}) {
    const checks = [];
    const config = this.config;
    const push = (c) => checks.push(c);

    // ---------------------------------------------------------- configuration
    const versionPair = config.versionCheck || {};
    if (config.errors?.length) {
      push(this.check('configuration', 'Configuration', LEVELS.FAIL, `The configuration is invalid: ${config.errors.join(' | ')}`, { hint: 'Fix config/config.toml and restart the panel.' }));
    } else if (versionPair.ok) {
      push(this.check('configuration', 'Configuration', LEVELS.OK,
        `config/config.toml is valid (Minecraft ${config.values.minecraft.version} + NeoForge ${config.values.minecraft.neoforge_version}).`));
    } else {
      push(this.check('configuration', 'Configuration', LEVELS.FAIL, versionPair.error || 'Invalid version pair.', { hint: versionPair.hint }));
    }
    for (const warning of config.warnings || []) {
      push(this.check('configuration-warning', 'Configuration warning', LEVELS.WARN, warning));
    }
    const knownPair = config.values.minecraft.version === '1.21.1' && config.values.minecraft.neoforge_version.startsWith('21.1.');
    if (knownPair) {
      push(this.check('versions', 'Version pair', LEVELS.OK, `Minecraft ${config.values.minecraft.version} with NeoForge ${config.values.minecraft.neoforge_version} (21.1.x is the correct NeoForge line for 1.21.1).`));
    }

    // ------------------------------------------------------------------ java
    const java = await this.java.detect({ force: true });
    if (java.found && java.meetsRequirement) {
      push(this.check('java', 'Java', java.exact && !java.fallbackFrom ? LEVELS.OK : LEVELS.WARN, `${java.version.full} (${java.version.vendor}) at ${java.path}.`, {
        hint: java.fallbackFrom
          ? `[minecraft].java_path is unusable (${java.fallbackFrom}): this JVM was found instead. Set java_path to "${java.path}" (or clear it) so the choice is explicit.`
          : java.exact ? undefined : java.detail,
      }));
    } else if (java.found) {
      push(this.check('java', 'Java', LEVELS.FAIL, `Java ${java.version.feature} found at ${java.path}, but Java ${java.requiredJava} is required for Minecraft ${config.values.minecraft.version}.`, { hint: `Install Java ${java.requiredJava} (Eclipse Temurin) and set [minecraft].java_path.` }));
    } else {
      push(this.check('java', 'Java', LEVELS.FAIL, 'Java was not found on this computer.', { hint: `Install Java ${java.requiredJava} from https://adoptium.net and restart the panel (or set [minecraft].java_path).` }));
    }

    // ----------------------------------------------------------- minecraft/neoforge
    const installStatus = await this.install.status();
    push(this.check('minecraft', 'Minecraft server files',
      installStatus.steps.neoforge && installStatus.versions.vanillaJar ? LEVELS.OK : LEVELS.WARN,
      installStatus.versions.vanillaJar ? `Vanilla server ${installStatus.versions.vanillaJar} present.` : 'The vanilla server jar has not been downloaded yet.',
      { hint: installStatus.versions.vanillaJar ? undefined : 'Run the installation (Settings -> Install / Repair) or `npm run install:server`.' }));
    push(this.check('neoforge', 'NeoForge',
      installStatus.steps.neoforge ? (installStatus.versions.installed === config.values.minecraft.neoforge_version ? LEVELS.OK : LEVELS.WARN) : LEVELS.WARN,
      installStatus.steps.neoforge
        ? `Installed: NeoForge ${installStatus.versions.installed} (launch args: ${installStatus.launch.relative}).`
        : 'NeoForge is not installed in the server directory.',
      { hint: installStatus.steps.neoforge ? undefined : 'Run the installation from the panel; it downloads the official installer.' }));
    push(this.check('eula', 'Minecraft EULA',
      installStatus.eulaAccepted ? LEVELS.OK : LEVELS.WARN,
      installStatus.eulaAccepted ? 'eula.txt is accepted.' : 'The Minecraft EULA is not accepted: the server will refuse to start.',
      { hint: installStatus.eulaAccepted ? undefined : 'Read https://aka.ms/MinecraftEULA and accept it from the Install / Repair section.' }));

    // ------------------------------------------------------- bundled admin mod
    // The mod is optional: the server runs without it, so a missing build is a
    // [WARN]/[INFO], never a [FAIL].
    if (this.adminModSvc) {
      const adminMod = await this.adminModSvc.status().catch((err) => ({ error: err }));
      if (adminMod.error) {
        push(this.check('admin-mod', 'Admin mod', LEVELS.WARN, `The bundled admin mod could not be inspected: ${adminMod.error.message}`));
      } else if (!adminMod.available) {
        push(this.check('admin-mod', 'Admin mod', LEVELS.WARN, 'The sources of the bundled admin mod were not found in mods-src/admin-tools.', { hint: 'Re-clone the repository, or fix [admin_mod].source_dir. The Minecraft server works without this mod.' }));
      } else if (!adminMod.java.suitable) {
        push(this.check('admin-mod', 'Admin mod', LEVELS.WARN,
          `The admin mod sources are ready but the configured Java ${adminMod.java.feature ?? '?'} cannot build them (JDK ${adminMod.java.required} needed).`,
          { hint: `Set [minecraft].java_path to a JDK ${adminMod.java.required}, then use "Build & install" on the Mods page.` }));
      } else if (adminMod.jar.installed) {
        push(this.check('admin-mod', 'Admin mod', LEVELS.OK,
          `admintools ${adminMod.mod.version} is installed in minecraft/server/mods (${modLine(adminMod)}).`));
      } else if (adminMod.jar.built) {
        push(this.check('admin-mod', 'Admin mod', LEVELS.WARN, `admintools ${adminMod.mod.version} is built (${adminMod.jar.file}) but not installed in minecraft/server/mods.`,
          { hint: 'Use "Build & install" on the Mods page, or copy build/libs/admintools-*.jar into minecraft/server/mods and restart the server.' }));
      } else {
        push(this.check('admin-mod', 'Admin mod', LEVELS.INFO,
          `admintools ${adminMod.mod.version} sources are ready (Minecraft ${adminMod.mod.minecraftVersion} + NeoForge ${adminMod.mod.neoForgeVersion}); it has not been built yet.`,
          { hint: 'Open the Mods page and click "Build & install" (the first build downloads Gradle and the NeoForge artefacts).' }));
      }
      if (adminMod.running) {
        push(this.check('admin-mod-build', 'Admin mod build', LEVELS.INFO, 'A build of the admin mod is currently running.'));
      }
    }

    // ------------------------------------------------------- /panel mod bridge
    if (this.bridge) {
      const bridgeStatus = this.bridge.status();
      if (config.values.bridge?.enabled === false) {
        push(this.check('bridge', 'Mod bridge', LEVELS.INFO, 'The bridge is disabled ([bridge].enabled = false), so the in-game /panel command cannot talk to the panel.', { hint: 'Set [bridge].enabled = true in config/config.toml to use /panel in game.' }));
      } else if (!bridgeStatus.modConfig.present) {
        push(this.check('bridge', 'Mod bridge', LEVELS.INFO,
          'The bridge token is ready but minecraft/server/config/admintools.properties does not exist yet.',
          { hint: 'Build and install the admin mod, then run: node api/cli.js bridge-token --write-mod-config' }));
      } else if (bridgeStatus.linked) {
        push(this.check('bridge', 'Mod bridge', LEVELS.OK,
          `The in-game /panel command can use the bridge (${bridgeStatus.useCount} request(s) so far).`));
      } else {
        push(this.check('bridge', 'Mod bridge', LEVELS.WARN,
          'The token in minecraft/server/config/admintools.properties does not match the panel token.',
          { hint: 'Run: node api/cli.js bridge-token --write-mod-config   (then restart the Minecraft server)' }));
      }
    }

    // ------------------------------------------------- player wake-up (public)
    // The public page has exactly one button a stranger can use. The host has to
    // know whether it is armed, switched off, or a dead button with no code set.
    if (this.power) {
      const power = this.power.status();
      if (config.values.public?.enabled === false) {
        push(this.check('power-on', 'Player wake-up', LEVELS.INFO, 'The public page is disabled, so players have no way to start the server.'));
      } else if (!power.enabled) {
        push(this.check('power-on', 'Player wake-up', LEVELS.INFO, 'Starting the server from the public page is switched off ([public].allow_power_on = false).', { hint: 'Turn it on and set [public].wake_code if you want friends to be able to wake the server up.' }));
      } else if (!power.configured) {
        push(this.check('power-on', 'Player wake-up', LEVELS.WARN, 'Players may wake the server up, but no wake-up code is set: the button stays closed and answers WAKE_NOT_CONFIGURED.', { hint: 'Set [public].wake_code in config/config.toml (a secret: never commit it, never paste it into the page), or set allow_power_on = false to remove the button.' }));
      } else {
        push(this.check('power-on', 'Player wake-up', LEVELS.OK,
          `A player can start the server from the public page with the wake-up code (${power.max_attempts} wrong attempt(s) per ${power.window_minutes} min per IP, ${power.wake_ups} wake-up(s) since startup).`,
          { hint: 'That line stays OK only because no code is ever written in a log or sent to the browser - the panel never displays it either.' }));
      }
    }

    // ------------------------------------------------------- /co block journal
    // The journal is written by the admin mod inside the server directory, so
    // the panel can report its real state (it never writes to it).
    {
      const journalDir = path.join(this.config.paths.serverDir, 'config', 'admintools', 'journal');
      const journal = await this.readJournal(journalDir);
      if (!journal.present) {
        push(this.check('journal', 'Block journal', LEVELS.INFO,
          'No journal file yet: it appears the first time a player breaks or places a block with the admin mod installed.',
          { hint: 'Build and install the bundled admin mod (Mods page), then restart the server.' }));
      } else {
        push(this.check('journal', 'Block journal', LEVELS.OK,
          `${journal.files} file(s), ${journal.human} in ${journalDir}${journal.oldest ? `, oldest entry ${journal.oldest}` : ''}.`));
      }
    }

    // ------------------------------------------- the data of the mod commands
    // Homes, warps, kits, graves and the blocked words live next to the journal.
    // The panel reads them to report what the players really produced; it never
    // writes there (the mod owns its own data files).
    {
      const data = await this.readModData(this.config.paths.serverDir);
      if (!data.present) {
        push(this.check('mod-data', 'Mod data (homes, warps, kits, graves)', LEVELS.INFO,
          'No essentials or grave data yet: the files appear the first time a player uses /sethome, /createkit, dies with the graves enabled, or an admin runs /chatfilter add.',
          { hint: 'Build and install the bundled admin mod (Mods page), then restart the server.' }));
      } else {
        const parts = [
          `${data.homes} home(s)`, `${data.warps} warp(s)`, `${data.kits} kit(s)`,
          `${data.graves} grave(s)`, `${data.waiting} item stack(s) waiting for /grave claim`,
          `${data.words} blocked word(s)`,
        ];
        push(this.check('mod-data', 'Mod data (homes, warps, kits, graves)', LEVELS.OK,
          `${parts.join(', ')} - ${data.files} file(s), ${data.human} in ${data.dir}.`));
      }
    }

    // ------------------------------------------------------- integrations
    {
      const dc = this.config.values.discord;
      const host = (() => {
        const raw = String(dc.webhook_url || '').trim();
        if (!raw) return null;
        try { return new URL(raw).host; } catch { return null; }
      })();
      if (!dc.enabled) {
        push(this.check('discord', 'Discord notifications', LEVELS.INFO,
          'Disabled. Enable [discord] and paste a webhook URL to get server events in a Discord channel.',
          { hint: 'Settings -> Discord, or DISCORD_ENABLED=true + DISCORD_WEBHOOK_URL=... in .env.' }));
      } else if (!dc.webhook_url) {
        push(this.check('discord', 'Discord notifications', LEVELS.WARN,
          '[discord] is enabled but webhook_url is empty, so nothing can be posted.',
          { hint: 'Channel settings -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.' }));
      } else if (!host) {
        push(this.check('discord', 'Discord notifications', LEVELS.FAIL,
          'The webhook URL is not a valid Discord webhook URL (https://discord.com/api/webhooks/...).',
          { hint: 'Copy the whole URL from the Discord channel settings.' }));
      } else {
        push(this.check('discord', 'Discord notifications', LEVELS.OK,
          `Configured on ${host} (${dc.events.length} event type(s) posted).`));
      }
    }
    {
      const restart = this.config.values.restart;
      if (!restart.enabled) {
        push(this.check('restart', 'Scheduled restarts', LEVELS.INFO, 'Disabled. Set [restart].enabled = true and add times such as ["04:00"].',
          { hint: 'Players are warned and a backup can be made before each restart.' }));
      } else {
        const times = restart.times.join(', ');
        const warns = restart.warn_minutes.join('/');
        push(this.check('restart', 'Scheduled restarts', LEVELS.OK,
          `Armed at ${times} (local time), players warned ${warns} minute(s) before${restart.auto_backup ? ', backup before each restart' : ''}.`));
      }
    }
    {
      const mo = this.config.values.monitor;
      push(this.check('monitor', 'MSPT monitor', LEVELS.OK,
        `Alert above ${mo.mspt_alert_ms} ms per tick sustained for ${mo.mspt_sustain_min} minute(s), then at most one alert every ${mo.alert_cooldown_min} minute(s).`));
    }

    // ------------------------------------------------------------------- ram
    const totalMb = totalMemoryMb();
    const maxRam = config.values.minecraft.max_ram_mb;
    const freeMb = Math.floor(os.freemem() / 1024 / 1024);
    if (totalMb < 4096) {
      push(this.check('ram', 'RAM', LEVELS.WARN, `This computer only has ${humanBytes(totalMb * 1024 * 1024)} of RAM; a modded 1.21 server usually needs 4-6 GB.`, { hint: 'Reduce the view distance and the number of mods.' }));
    } else if (maxRam > totalMb - 1024) {
      push(this.check('ram', 'RAM', LEVELS.WARN, `[minecraft].max_ram_mb is ${maxRam} MB but only ${totalMb} MB are installed (${freeMb} MB free right now).`, { hint: `Lower max_ram_mb to about ${Math.max(2048, totalMb - 2048)} MB so the operating system and the panel keep working.` }));
    } else {
      push(this.check('ram', 'RAM', LEVELS.OK, `${totalMb} MB installed, ${maxRam} MB reserved for Minecraft, ${freeMb} MB currently free.`));
    }

    // ------------------------------------------------------------------ disk
    const usage = await this.files.diskUsage();
    if (usage.error) push(this.check('disk', 'Disk space', LEVELS.WARN, usage.error));
    else {
      const freeGb = usage.freeBytes / 1024 ** 3;
      const level = freeGb < 2 ? LEVELS.FAIL : freeGb < 8 ? LEVELS.WARN : LEVELS.OK;
      push(this.check('disk', 'Disk space', level, `${usage.freeHuman} free of ${usage.totalHuman} (server folder: ${config.paths.serverDir}).`,
        { hint: level === LEVELS.OK ? undefined : 'Free some space: the world, mods and backups all live on this disk.' }));
    }

    // ----------------------------------------------------------- permissions
    try {
      await ensureDir(config.paths.serverDir);
      await ensureDir(config.paths.logsDir);
      await ensureDir(config.paths.backupsDir);
      const probe = path.join(config.paths.logsDir, `.doctor-${Date.now()}.tmp`);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
      const worldProbe = path.join(config.paths.serverDir, '.doctor-write-test');
      await fsp.writeFile(worldProbe, 'ok');
      await fsp.rm(worldProbe, { force: true });
      push(this.check('permissions', 'Permissions', LEVELS.OK, 'The server, log and backup directories are writable.'));
    } catch (err) {
      push(this.check('permissions', 'Permissions', LEVELS.FAIL, `A required directory is not writable: ${err.message}`, { hint: 'Run the panel from a normal user account that owns the project folder, and close any program locking these files.' }));
    }
    const authStat = await statOrNull(config.paths.authFile);
    if (authStat) {
      const mode = authStat.mode & 0o777;
      push(this.check('authfile', 'Admin credentials file', process.platform === 'win32' || mode <= 0o600 ? LEVELS.OK : LEVELS.WARN,
        `config/auth.json exists (mode ${mode.toString(8)}).`,
        { hint: process.platform === 'win32' || mode <= 0o600 ? undefined : 'Restrict it with: chmod 600 config/auth.json' }));
    }

    // ------------------------------------------------------------------ ports
    if (!this.minecraft.isRunning()) {
      const free = await isPortFree(config.values.minecraft.port, '0.0.0.0');
      push(this.check('mc-port', 'Minecraft port', free ? LEVELS.OK : LEVELS.FAIL,
        free ? `Port ${config.values.minecraft.port} is free.` : `Port ${config.values.minecraft.port} is already in use.`,
        { hint: free ? undefined : 'Close the other process or change [minecraft].port.' }));
    } else {
      push(this.check('mc-port', 'Minecraft port', LEVELS.OK, `The server is running on port ${config.values.minecraft.port} (pid ${this.minecraft.pid}).`));
    }
    for (const [label, port] of [['admin', config.values.admin.port], ['public', config.values.public.port]]) {
      const listening = await canConnect(port, '127.0.0.1', { timeoutMs: 800 });
      if (!listening) {
        push(this.check(`${label}-port`, `${label === 'admin' ? 'Admin' : 'Public'} web port`, LEVELS.INFO, `Nothing is listening on port ${port}.`));
        continue;
      }
      // Something answers: is it our own app? (a second panel instance, or the
      // running one, is a normal situation, not a failure.)
      const probePath = label === 'admin' ? '/api/admin/health' : '/api/public/health';
      const probe = await fetchJson(`http://127.0.0.1:${port}${probePath}`, { timeoutMs: 1500, maxBytes: 32 * 1024 }).catch(() => null);
      const isOurApp = Boolean(probe && probe.ok === true);
      push(this.check(`${label}-port`, `${label === 'admin' ? 'Admin' : 'Public'} web port`, isOurApp ? LEVELS.OK : LEVELS.FAIL,
        isOurApp
          ? `Port ${port} is serving the ${label} app already (the panel is running).`
          : `Port ${port} is in use by another program.`,
        {
          hint: isOurApp
            ? (label === 'admin' ? 'Open http://127.0.0.1:' + port + ' - only one panel instance can bind this port.' : undefined)
            : `Close the program using port ${port}, or change [${label}].port in config/config.toml.`,
        }));
    }

    // -------------------------------------------------------------- network
    if (includeNetwork) {
      const net = await checkInternet();
      const mojang = net.results.find((r) => r.url.includes('piston-meta'));
      const broker = net.results.find((r) => r.url.includes('e4mc'));
      push(this.check('network', 'Network (Mojang)', mojang?.ok ? LEVELS.OK : LEVELS.WARN,
        mojang?.ok ? `piston-meta.mojang.com reachable (${mojang.ms} ms).` : 'piston-meta.mojang.com is not reachable: installing/updating Minecraft will fail.',
        { hint: mojang?.ok ? undefined : 'Check your internet connection, DNS, VPN or proxy.' }));
      push(this.check('network-e4mc', 'Network (e4mc relay)', broker?.ok ? LEVELS.OK : LEVELS.WARN,
        broker?.ok ? `broker.e4mc.link reachable (${broker.ms} ms).` : 'broker.e4mc.link is not reachable: the public e4mc address will not be available.',
        { hint: broker?.ok ? undefined : 'The Minecraft server still works on your LAN. Check status.e4mc.link and your firewall.' }));
    }

    // ------------------------------------------------------------------ e4mc
    if (!config.values.e4mc.enabled) {
      push(this.check('e4mc', 'e4mc', LEVELS.WARN, 'e4mc is disabled: players outside your network cannot join.', { hint: 'Enable [e4mc].enabled in the Settings page.' }));
    } else {
      const status = await this.e4mcSvc.runtimeStatus();
      if (status.state === E4MC_STATES.ONLINE && status.address) {
        push(this.check('e4mc', 'e4mc', LEVELS.OK, `Online, public address: ${status.address} (${status.addressSource}).`));
      } else if (status.state === E4MC_STATES.MISSING) {
        push(this.check('e4mc', 'e4mc', LEVELS.FAIL, 'The official e4mc relay client (e4mcbiat.jar) is missing.', { hint: `Expected at ${status.jar.path}. Download it from https://github.com/DuncanRuns/e4mcbiat/releases or enable auto_download.` }));
      } else if (status.state === E4MC_STATES.ERROR) {
        push(this.check('e4mc', 'e4mc', LEVELS.WARN, status.error?.message || 'The e4mc relay reported an error.', { hint: status.error?.hint }));
      } else {
        push(this.check('e4mc', 'e4mc', LEVELS.INFO, `State: ${status.state}${status.address ? ` (last address: ${status.address})` : ''}. Start the server to publish an address.`));
      }
      if (status.jar.present) {
        push(this.check('e4mc-jar', 'e4mc relay client', LEVELS.OK, `e4mcbiat present (${status.jar.sizeHuman}).`));
      }
    }

    // ------------------------------------------------------------ cloudflare
    const cfStatus = await this.cloudflare.status();
    if (!cfStatus.enabled) {
      push(this.check('cloudflare', 'Cloudflare', LEVELS.WARN, 'Cloudflare is disabled: the public page is only reachable on your network.', { hint: 'Enable [cloudflare].enabled and [cloudflare].tunnel_enabled to publish it, or ignore this if you do not want a public page.' }));
    } else {
      const level = cfStatus.state === 'online' ? LEVELS.OK : cfStatus.state === 'ready' ? LEVELS.INFO : LEVELS.WARN;
      push(this.check('cloudflare', 'Cloudflare', level,
        `State: ${cfStatus.state}${cfStatus.url ? ` - ${cfStatus.url}` : ''}${cfStatus.hostname ? ` (hostname ${cfStatus.hostname})` : ''}.`,
        { hint: cfStatus.error?.hint }));
      if (cfStatus.tunnelEnabled && !cfStatus.cloudflared.found) {
        push(this.check('cloudflared', 'cloudflared', LEVELS.FAIL, 'The cloudflared binary was not found.', { hint: 'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ and set [cloudflare].cloudflared_path if needed.' }));
      }
      if (cfStatus.tunnelEnabled && !cfStatus.location.credentialsExist && !cfStatus.tunnelServiceTokenProvided) {
        push(this.check('cloudflare-credentials', 'Cloudflare tunnel credentials', LEVELS.WARN,
          `No credentials file at ${cfStatus.location.credentialsFile} and no CLOUDFLARE_TUNNEL_TOKEN set.`,
          { hint: `Run: cloudflared tunnel login && cloudflared tunnel create ${cfStatus.tunnelName}` }));
      }
      if (cfStatus.adminExposureBlocked) {
        push(this.check('cloudflare-scope', 'Cloudflare scope', LEVELS.OK, `The tunnel targets ${cfStatus.service} (public page only); the admin panel on port ${config.values.admin.port} is never exposed.`));
      }
      if (cfStatus.tokenConfigured) {
        const api = await this.cloudflare.verifyApi();
        push(this.check('cloudflare-api', 'Cloudflare API', api.ok ? LEVELS.OK : LEVELS.WARN, api.ok ? `API token valid, zone ${api.zone?.name}.` : api.message || 'The Cloudflare API could not be verified.', { hint: api.hint }));
      }
    }

    // --------------------------------------------------------------- backups
    const [backupList, backupUsage] = await Promise.all([this.backups.list(), this.backups.usage()]);
    push(this.check('backups', 'Backups', backupList.count ? LEVELS.OK : LEVELS.WARN,
      backupList.count ? `${backupList.count} backup(s), ${backupUsage.human} in ${backupUsage.dir}.` : 'No backup exists yet.',
      { hint: backupList.count ? undefined : 'Create one from the Backups page before you install new mods.' }));
    if (config.values.backups.safety_backup_before_restore === false) {
      push(this.check('backup-safety', 'Restore safety net', LEVELS.WARN, 'safety_backup_before_restore is disabled: a restore can destroy data without a safety copy.'));
    }

    // ----------------------------------------------------------------- misc
    push(this.check('node', 'Node.js', LEVELS.OK, `${process.version} on ${process.platform}/${process.arch} (${cpuCount()} CPU cores).`));
    const summary = {
      ok: checks.filter((c) => c.level === LEVELS.OK).length,
      warn: checks.filter((c) => c.level === LEVELS.WARN).length,
      fail: checks.filter((c) => c.level === LEVELS.FAIL).length,
      info: checks.filter((c) => c.level === LEVELS.INFO).length,
    };
    return { at: new Date().toISOString(), checks, summary, healthy: summary.fail === 0 };
  }

  /** Terminal rendering: [OK] Java ... */
  format(result) {
    const pad = Math.max(...result.checks.map((c) => c.label.length), 4);
    const lines = [];
    lines.push('==================================================');
    lines.push(' Minecraft Server Manager - doctor');
    lines.push('==================================================');
    for (const check of result.checks) {
      const tag = LEVEL_TAGS[check.level] || '[INFO]';
      lines.push(`${tag} ${check.label.padEnd(pad)}  ${check.message}`);
      if (check.hint && check.level !== LEVELS.OK) lines.push(`${' '.repeat(7)}${''.padEnd(pad)}  -> ${check.hint}`);
    }
    lines.push('--------------------------------------------------');
    lines.push(` ${result.summary.ok} ok, ${result.summary.warn} warning(s), ${result.summary.fail} failure(s)`);
    lines.push(result.healthy ? ' Result: no blocking problem detected.' : ' Result: fix the [FAIL] lines above before starting the server.');
    lines.push('==================================================');
    return lines.join('\n');
  }
}

/** Small helper for the admin-mod check message. */
function modLine(status) {
  const parts = [];
  if (status.mod.minecraftVersion) parts.push(`Minecraft ${status.mod.minecraftVersion}`);
  if (status.mod.neoForgeVersion) parts.push(`NeoForge ${status.mod.neoForgeVersion}`);
  if (status.jar.installedAt) parts.push(`installed ${new Date(status.jar.installedAt).toISOString().slice(0, 19).replace('T', ' ')}`);
  return parts.join(', ') || 'server-side admin commands';
}

export { whichSync };
