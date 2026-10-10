/**
 * Installation / verification of the Minecraft + NeoForge server files.
 *
 * Real upstream sources only:
 *   - Mojang version manifest  (piston-meta.mojang.com)          -> vanilla server jar
 *   - NeoForge maven           (maven.neoforged.net)             -> installer + version list
 *   - GitHub releases          (DuncanRuns/e4mcbiat)             -> e4mc relay client
 *
 * The installer is executed exactly the way the NeoForge documentation
 * describes it:  java -jar neoforge-<version>-installer.jar --installServer .
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, ServiceUnavailableError } from '../util/errors.js';
import { ensureDir, pathExists, writeFileAtomic, readJson, writeJson, sha1File, humanBytes } from '../util/fsx.js';
import { downloadFile, fetchJson, fetchText } from '../util/net.js';
import { spawnProcess, terminateProcess } from '../util/proc.js';
import {
  MOJANG_VERSION_MANIFEST, NEOFORGE_METADATA_URL, neoforgeInstallerUrl, neoforgeArgsFile,
  recommendedJvmArgs, parseNeoForgeMetadata, sortNeoForgeVersions, neoforgePrefixFor,
  normalizeVersionMeta,
} from '../util/mcversions.js';
import { ServerProperties, DEFAULT_PROPERTIES } from './ServerProperties.js';

export class InstallService {
  constructor({ config, logs, java, events }) {
    this.config = config;
    this.logs = logs;
    this.log = logs.application.child('install');
    this.java = java;
    this.events = events;
  }

  get serverDir() {
    return this.config.paths.serverDir;
  }

  /** Create the whole directory tree the project needs. */
  async ensureLayout() {
    const dirs = [
      this.config.paths.serverDir,
      path.join(this.config.paths.serverDir, 'mods'),
      path.join(this.config.paths.serverDir, 'config'),
      path.join(this.config.paths.serverDir, 'logs'),
      path.join(this.config.paths.serverDir, 'world'),
      this.config.paths.minecraftRoot,
      path.join(this.config.paths.minecraftRoot, 'launcher'),
      path.join(this.config.paths.minecraftRoot, 'cache'),
      this.config.paths.logsDir,
      this.config.paths.backupsDir,
      this.config.paths.configDir,
      this.config.paths.cloudflareDir,
      this.config.paths.runDir,
      path.join(this.config.paths.panelDir),
      path.join(this.config.paths.publicDir),
    ];
    for (const dir of dirs) await ensureDir(dir);
    return dirs;
  }

  /** Current installation state (used by doctor, the installer UI and start()). */
  async status() {
    const mc = this.config.values.minecraft;
    const dir = this.serverDir;
    const args = neoforgeArgsFile(dir, mc.neoforge_version);
    const [dirExists, argsExists, eulaExists, propsExists, runSh, runBat] = await Promise.all([
      pathExists(dir),
      pathExists(path.join(dir, args.relative)),
      pathExists(path.join(dir, 'eula.txt')),
      pathExists(path.join(dir, 'server.properties')),
      pathExists(path.join(dir, 'run.sh')),
      pathExists(path.join(dir, 'run.bat')),
    ]);
    const detected = await this.detectInstalledVersions();
    const eulaText = eulaExists ? await fsp.readFile(path.join(dir, 'eula.txt'), 'utf8').catch(() => '') : '';
    const eulaAccepted = /eula\s*=\s*true/i.test(eulaText);

    const steps = {
      directories: dirExists,
      neoforge: argsExists || Boolean(detected.installed),
      vanillaJar: Boolean(detected.vanillaJar),
      eula: eulaAccepted,
      serverProperties: propsExists,
      jvmArgs: await pathExists(path.join(dir, 'user_jvm_args.txt')),
      e4mcRelay: await this.e4mcStatus(),
    };
    return {
      serverDir: dir,
      installed: Boolean(steps.neoforge && steps.vanillaJar),
      ready: Boolean(steps.neoforge && steps.vanillaJar && steps.eula && steps.serverProperties),
      steps,
      launch: { ...args, exists: argsExists, script: runBat ? 'run.bat' : runSh ? 'run.sh' : null },
      versions: detected,
      configured: { minecraft: mc.version, neoforge: mc.neoforge_version },
      eulaAccepted,
    };
  }

  /** Read what is actually installed in the server directory. */
  async detectInstalledVersions() {
    const dir = this.serverDir;
    const out = { installed: null, vanillaJar: null, argsFile: null };
    const runScript = await this.readRunScript();
    if (runScript?.argsFile) out.argsFile = runScript.argsFile;

    const neoforgeLibDir = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge');
    try {
      const versions = (await fsp.readdir(neoforgeLibDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      if (versions.length) out.installed = versions.sort().pop();
    } catch {
      /* not installed */
    }
    const mcLibDir = path.join(dir, 'libraries', 'net', 'minecraft', 'server');
    try {
      const versions = (await fsp.readdir(mcLibDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      if (versions.length) out.vanillaJar = versions.sort().pop();
    } catch {
      /* not installed */
    }
    if (!out.vanillaJar) {
      // Some installer versions keep the vanilla jar at the root of the folder.
      for (const candidate of ['server.jar', 'minecraft_server.jar']) {
        if (await pathExists(path.join(dir, candidate))) {
          out.vanillaJar = candidate;
          break;
        }
      }
    }
    return out;
  }

  /**
   * Read the argument file referenced by the installer's run script.
   * This is what makes the launcher resilient to NeoForge layout changes.
   */
  async readRunScript() {
    const scripts = process.platform === 'win32' ? ['run.bat', 'run.sh'] : ['run.sh', 'run.bat'];
    for (const name of scripts) {
      const file = path.join(this.serverDir, name);
      try {
        const text = await fsp.readFile(file, 'utf8');
        const match = [...text.matchAll(/@([^\s"']+args\.txt)/g)]
          .find((candidate) => path.basename(candidate[1]).toLowerCase() !== 'user_jvm_args.txt');
        if (match) {
          const rel = match[1].replace(/\\/g, path.sep).replace(/\//g, path.sep);
          return { script: name, argsFile: rel, exists: await pathExists(path.join(this.serverDir, rel)) };
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }

  async e4mcStatus() {
    if (!this.config.values.e4mc.enabled) return { enabled: false, present: false };
    const present = await pathExists(this.config.paths.e4mcJar);
    let size = null;
    if (present) {
      const stat = await fsp.stat(this.config.paths.e4mcJar).catch(() => null);
      size = stat?.size ?? null;
    }
    return { enabled: true, present, path: this.config.paths.e4mcJar, size, sizeHuman: size ? humanBytes(size) : null };
  }

  /** Versions available upstream for the configured Minecraft version. */
  async availableNeoForgeVersions({ includePrerelease = false } = {}) {
    const url = NEOFORGE_METADATA_URL;
    const xml = await fetchText(url, { timeoutMs: 30000 });
    const prefix = neoforgePrefixFor(this.config.values.minecraft.version);
    const filtered = parseNeoForgeMetadata(xml, { prefix, includePrerelease });
    return {
      prefix,
      latest: sortNeoForgeVersions(filtered.filter((v) => !v.prerelease).map((v) => v.version)).pop() || null,
      versions: sortNeoForgeVersions(filtered.map((v) => v.version)).reverse(),
      source: url.replace(/^https:\/\//, ''),
    };
  }

  /** Fetch (and cache) the Mojang manifest entry for the configured version. */
  async resolveVanillaServer({ force = false } = {}) {
    const version = this.config.values.minecraft.version;
    const cacheFile = path.join(this.config.paths.minecraftRoot, 'cache', `version-${version}.json`);
    // The cache holds the flat record written below. It is validated with the
    // same normalizer that accepts a raw Mojang version detail, so a cached
    // entry is really reusable offline instead of being refetched every time.
    const cached = force ? null : normalizeVersionMeta(await readJson(cacheFile, null));
    if (cached) return cached;
    this.log.info(`Resolving Minecraft ${version} server jar from the Mojang version manifest...`);
    const manifest = await fetchJson(MOJANG_VERSION_MANIFEST, { timeoutMs: 30000 });
    const entry = (manifest.versions || []).find((v) => v.id === version);
    if (!entry) {
      throw new AppError(`Minecraft version ${version} does not exist in Mojang's version manifest.`, {
        code: 'MINECRAFT_VERSION_UNKNOWN',
        status: 400,
        hint: 'Check [minecraft].version in config/config.toml (for example 1.21.1).',
      });
    }
    const detail = await fetchJson(entry.url, { timeoutMs: 30000 });
    const meta = normalizeVersionMeta(detail);
    if (!meta) {
      throw new AppError(`Minecraft ${version} has no server download in the Mojang manifest.`, { code: 'MINECRAFT_SERVER_UNAVAILABLE', status: 502 });
    }
    await writeJson(cacheFile, meta);
    return meta;
  }

  /** Download the vanilla server jar into minecraft/cache (sha1 verified). */
  async downloadVanillaServer({ onProgress = null } = {}) {
    const meta = await this.resolveVanillaServer();
    const dest = path.join(this.config.paths.minecraftRoot, 'cache', `server-${meta.id}.jar`);
    if (await pathExists(dest)) {
      const sha1 = await sha1File(dest);
      if (sha1 === meta.sha1) return { ...meta, path: dest, cached: true };
      this.log.warn(`Cached vanilla server jar checksum mismatch, re-downloading ${meta.id}.`);
    }
    this.log.info(`Downloading the Minecraft ${meta.id} server jar (${humanBytes(meta.size)})...`);
    await downloadFile(meta.url, dest, { sha1: meta.sha1, onProgress });
    return { ...meta, path: dest, cached: false };
  }

  /**
   * Run the official NeoForge installer (`--installServer`).
   * Nothing is patched by the panel: the official installer does the work.
   */
  async installNeoForge({ onProgress = null, javaPath = null, timeoutMs = 45 * 60 * 1000 } = {}) {
    const mc = this.config.values.minecraft;
    const java = javaPath || (await this.java.requireUsable()).path;
    const installerUrl = neoforgeInstallerUrl(mc.neoforge_version);
    const installerFile = path.join(this.config.paths.minecraftRoot, 'cache', `neoforge-${mc.neoforge_version}-installer.jar`);

    if (!(await pathExists(installerFile))) {
      this.log.info(`Downloading the NeoForge ${mc.neoforge_version} installer...`);
      let sha1 = null;
      try {
        sha1 = (await fetchText(`${installerUrl}.sha1`, { timeoutMs: 20000 })).trim().split(/\s+/)[0];
        if (!/^[a-f0-9]{40}$/i.test(sha1)) sha1 = null;
      } catch {
        this.log.warn('NeoForge did not publish a .sha1 for the installer; continuing without checksum verification.');
      }
      await downloadFile(installerUrl, installerFile, { sha1, onProgress, timeoutMs: 30 * 60 * 1000 });
    } else {
      this.log.info('Using the cached NeoForge installer.');
    }

    await ensureDir(this.serverDir);
    this.log.info(`Running the NeoForge installer for Minecraft ${mc.version} (this can take several minutes)...`);
    onProgress?.({ phase: 'installer', message: `Running the official NeoForge ${mc.neoforge_version} installer` });

    await new Promise((resolve, reject) => {
      const child = spawnProcess(java, ['-jar', installerFile, '--installServer', this.serverDir], { cwd: this.serverDir });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new AppError('The NeoForge installer timed out after 45 minutes.', { code: 'INSTALL_TIMEOUT', status: 500, hint: 'Check your internet connection, then retry the installation.' }));
      }, timeoutMs);
      const relay = (stream, level) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            this.log[level](line.trim());
            onProgress?.({ phase: 'installer', message: line.trim() });
          }
        });
      };
      relay(child.stdout, 'info');
      relay(child.stderr, 'warn');
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new AppError(`Could not start the NeoForge installer: ${err.message}`, {
          code: 'INSTALLER_SPAWN_FAILED', status: 500, hint: 'Verify [minecraft].java_path points to a working Java 21 runtime.',
        }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          reject(new AppError(`The NeoForge installer exited with code ${code}.`, {
            code: 'INSTALLER_FAILED',
            status: 500,
            hint: 'Read the installer output above. Common causes: no internet access to maven.neoforged.net and piston-meta.mojang.com, disk full, or an antivirus blocking Java.',
          }));
        }
      });
    });

    const status = await this.status();
    if (!status.steps.neoforge) {
      throw new AppError('The installer finished but no NeoForge launch arguments were found.', {
        code: 'INSTALL_INCOMPLETE', status: 500,
        hint: `Expected ${neoforgeArgsFile(this.serverDir, mc.neoforge_version).relative} to exist after the installation.`,
      });
    }
    this.log.info('NeoForge installation completed successfully.');
    return status;
  }

  async writeEula(accepted) {
    const file = path.join(this.serverDir, 'eula.txt');
    const text = `# By changing the setting below to TRUE you are indicating your agreement to the Minecraft EULA
# (https://aka.ms/MinecraftEULA). Accepted through the local panel on ${new Date().toISOString()}.
eula=${accepted ? 'true' : 'false'}
`;
    await writeFileAtomic(file, text, 'utf8');
    return file;
  }

  async writeServerProperties({ port = this.config.values.minecraft.port, motd = null, overwrite = false } = {}) {
    const file = path.join(this.serverDir, 'server.properties');
    const props = new ServerProperties(file);
    await props.load();
    props.applyDefaults({
      ...DEFAULT_PROPERTIES,
      'server-port': port,
      motd: motd || `${this.config.values.server.name} - NeoForge ${this.config.values.minecraft.neoforge_version}`,
      'max-players': 20,
      ...(this.config.values.minecraft.online_mode === false ? { 'online-mode': false } : {}),
    }, { overwrite });
    await props.save();
    return props;
  }

  /** Write the managed user_jvm_args.txt used by the NeoForge launch scripts. */
  async writeJvmArgs({ overwrite = false } = {}) {
    const file = path.join(this.serverDir, 'user_jvm_args.txt');
    const mc = this.config.values.minecraft;
    const exists = await pathExists(file);
    if (exists && !overwrite) {
      const text = await fsp.readFile(file, 'utf8');
      if (!/Managed by the local panel/.test(text)) {
        // Respect a hand-tuned file, but still make sure memory settings exist.
        const hasXmx = /-Xmx\S+/.test(text);
        if (!hasXmx) {
          await fsp.appendFile(file, `\n# Managed by the local panel: memory settings from config/config.toml\n-Xms${mc.min_ram_mb}M\n-Xmx${mc.max_ram_mb}M\n`, 'utf8');
          this.log.info('Added the configured memory settings to the existing user_jvm_args.txt.');
        } else {
          this.log.info('Keeping the existing user_jvm_args.txt (it already defines -Xmx).');
        }
        return { file, managed: false, keptExisting: true };
      }
    }
    const args = [...recommendedJvmArgs(mc.version, { maxRamMb: mc.max_ram_mb, minRamMb: mc.min_ram_mb }), ...(mc.jvm_args || [])];
    const text = `# Managed by the local panel - regenerated from config/config.toml.
# Manual changes are overwritten when you press "Write JVM arguments" in Settings.
${args.join('\n')}
`;
    await writeFileAtomic(file, text, 'utf8');
    return { file, managed: true, args };
  }

  /** Download the official e4mc relay client (e4mcbiat) from GitHub releases. */
  async downloadE4mcRelay({ onProgress = null } = {}) {
    const dest = this.config.paths.e4mcJar;
    await ensureDir(path.dirname(dest));
    const release = await fetchJson('https://api.github.com/repos/DuncanRuns/e4mcbiat/releases/latest', {
      timeoutMs: 30000,
      headers: { accept: 'application/vnd.github+json' },
    }).catch((err) => {
      throw new ServiceUnavailableError(`Could not query the e4mcbiat releases on GitHub: ${err.message}`, {
        code: 'E4MC_DOWNLOAD_FAILED',
        hint: 'Place the e4mcbiat jar manually in minecraft/launcher/e4mcbiat.jar and disable [e4mc].auto_download.',
      });
    });
    const asset = (release.assets || []).find((a) => /e4mcbiat-[0-9.]+-all\.jar$/.test(a.name));
    if (!asset) {
      throw new ServiceUnavailableError(`No e4mcbiat jar asset was found in release ${release.tag_name}.`, { code: 'E4MC_ASSET_MISSING' });
    }
    this.log.info(`Downloading the official e4mc relay client (e4mcbiat ${release.tag_name})...`);
    await downloadFile(asset.browser_download_url, dest, { onProgress, timeoutMs: 10 * 60 * 1000 });
    await writeJson(path.join(path.dirname(dest), 'e4mcbiat.json'), {
      tag: release.tag_name, asset: asset.name, url: asset.browser_download_url, downloadedAt: new Date().toISOString(),
    });
    return { path: dest, tag: release.tag_name, asset: asset.name, size: asset.size };
  }

  /**
   * Full first-run installation: layout, java check, vanilla jar, NeoForge
   * installer, eula, server.properties, jvm args and the e4mc relay.
   */
  async install({ acceptEula = false, onProgress = null, includeE4mc = this.config.values.e4mc.enabled } = {}) {
    const steps = [];
    const step = async (id, label, fn) => {
      onProgress?.({ phase: id, message: label, percent: null });
      const result = await fn();
      steps.push({ id, label, ok: true });
      return result;
    };

    await this.ensureLayout();
    const java = await step('java', 'Checking the Java runtime', () => this.java.requireUsable());
    await step('vanilla', 'Downloading the vanilla Minecraft server jar', () => this.downloadVanillaServer({ onProgress }));
    const installStatus = await step('neoforge', `Installing NeoForge ${this.config.values.minecraft.neoforge_version}`, () => this.installNeoForge({ onProgress, javaPath: java.path }));
    if (acceptEula) {
      await step('eula', 'Accepting the Minecraft EULA', () => this.writeEula(true));
    } else {
      const existing = await this.status();
      if (!existing.eulaAccepted) {
        steps.push({ id: 'eula', label: 'Minecraft EULA not accepted yet', ok: false });
      }
    }
    let properties = null;
    await step('properties', 'Writing server.properties', async () => {
      properties = await this.writeServerProperties({});
      return properties;
    });
    let jvm = null;
    await step('jvm', 'Writing the JVM arguments', async () => {
      jvm = await this.writeJvmArgs({});
      return jvm;
    });
    let e4mc = null;
    if (includeE4mc) {
      try {
        e4mc = await step('e4mc', 'Downloading the e4mc relay client', async () => {
          if (await pathExists(this.config.paths.e4mcJar)) {
            const stat = await fsp.stat(this.config.paths.e4mcJar);
            return { path: this.config.paths.e4mcJar, cached: true, size: stat.size };
          }
          return this.downloadE4mcRelay({ onProgress });
        });
      } catch (err) {
        steps.push({ id: 'e4mc', label: `e4mc relay download failed: ${err.message}`, ok: false, error: err.toJSON?.() || { message: err.message } });
        this.log.warn(`e4mc relay download failed: ${err.message}`);
      }
    }
    const status = await this.status();
    return { steps, status, java, installStatus, properties: properties?.toObject(), jvmArgs: jvm, e4mc };
  }
}
