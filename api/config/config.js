/**
 * Central configuration.
 *
 * Precedence (highest wins):
 *   1. environment variables (.env file loaded into process.env, or real env)
 *   2. config/config.toml
 *   3. built-in defaults (api/config/defaults.js)
 *
 * The loader validates everything and produces precise errors, so a broken
 * configuration is never discovered halfway through a server start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { parse as parseToml } from 'smol-toml';
import { DEFAULTS, ENV_MAP } from './defaults.js';
import { AppError, ConfigError } from '../util/errors.js';
import { asBool, asInt, asStringArray, HOSTNAME_RE } from '../util/validate.js';
import { validateVersionPair, javaRequirementFor } from '../util/mcversions.js';
import { DISCORD_WEBHOOK_RE, DISCORD_EVENT_NAMES } from '../discord/DiscordService.js';
import { ensureDirSync, readJsonSync, writeFileAtomic } from '../util/fsx.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = process.env.PANEL_ROOT ? path.resolve(process.env.PANEL_ROOT) : path.resolve(HERE, '..', '..');

/** Minimal dotenv parser: KEY=value, comments, quotes, no expansion. */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadDotEnv(file = path.join(PROJECT_ROOT, '.env')) {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

function coerce(value, reference) {
  if (typeof reference === 'boolean') return asBool(value, 'value');
  if (typeof reference === 'number') return asInt(value, 'value');
  if (Array.isArray(reference)) return asStringArray(value, 'value');
  return String(value);
}

export function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] && !Array.isArray(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Serialise a JS value as a TOML scalar/array (config values only). */
export function toTomlValue(value) {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  if (Array.isArray(value)) return `[${value.map((v) => toTomlValue(v)).join(', ')}]`;
  if (value === null || value === undefined) return '""';
  return JSON.stringify(String(value));
}

/**
 * Replace `key = ...` inside `[section]` of a TOML document, preserving every
 * comment and the rest of the file. Falls back to appending the key/section.
 */
export function updateTomlDocument(text, section, key, value) {
  const lines = String(text).split(/\r?\n/);
  const sectionHeader = `[${section}]`;
  let sectionStart = lines.findIndex((l) => l.trim() === sectionHeader);
  const rendered = `${key} = ${toTomlValue(value)}`;
  if (sectionStart === -1) {
    const out = [...lines];
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(sectionHeader, rendered);
    return `${out.join('\n')}\n`;
  }
  let end = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  for (let i = sectionStart + 1; i < end; i += 1) {
    if (keyRe.test(lines[i])) {
      lines[i] = rendered;
      return lines.join('\n');
    }
  }
  // Insert after the last non-empty line of the section (before trailing blank lines).
  let insertAt = end;
  while (insertAt - 1 > sectionStart && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, rendered);
  return lines.join('\n');
}

const HOSTS_OK = ['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1'];

export class Config extends EventEmitter {
  constructor({ projectRoot = PROJECT_ROOT, env = process.env, console: withConsole = false } = {}) {
    super();
    this.projectRoot = projectRoot;
    this.env = env;
    this.configFile = path.join(projectRoot, 'config', 'config.toml');
    this.exampleFile = path.join(projectRoot, 'config', 'config.example.toml');
    this.values = structuredClone(DEFAULTS);
    this.errors = [];
    this.warnings = [];
    this.loaded = false;
    this.withConsole = withConsole;
  }

  /** Read config.toml (creating it from the example on first run). */
  readTomlFile() {
    ensureDirSync(path.dirname(this.configFile));
    if (!fs.existsSync(this.configFile)) {
      if (fs.existsSync(this.exampleFile)) {
        fs.copyFileSync(this.exampleFile, this.configFile);
      } else {
        fs.writeFileSync(this.configFile, '# Created automatically by the panel\nexample = true\n', 'utf8');
      }
      this.createdFile = true;
    }
    const text = fs.readFileSync(this.configFile, 'utf8');
    try {
      return { toml: parseToml(text), text };
    } catch (err) {
      throw new ConfigError(`config/config.toml is not valid TOML: ${err.message}`, {
        hint: 'Fix the syntax (line numbers are in the message) or delete the file to regenerate it from config/config.example.toml.',
      });
    }
  }

  applyEnvOverrides(values, env) {
    const applied = [];
    for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
      const raw = env[envKey];
      if (raw === undefined || raw === '') continue;
      const [section, key] = configPath.split('.');
      try {
        values[section][key] = coerce(raw, DEFAULTS[section][key]);
        applied.push(configPath);
      } catch (err) {
        this.errors.push(`Environment variable ${envKey} (${configPath}): ${err.message}`);
      }
    }
    return applied;
  }

  load() {
    this.errors = [];
    this.warnings = [];
    const { toml } = this.readTomlFile();
    // Ignore unknown top-level sections? No: keep the file the source of truth
    // but only merge the keys we know about, so typos are reported.
    const knownToml = {};
    for (const section of Object.keys(DEFAULTS)) {
      if (toml[section] && typeof toml[section] === 'object') knownToml[section] = {};
      else if (toml[section] !== undefined) {
        this.errors.push(`Section [${section}] must be a TOML table.`);
        continue;
      }
      if (!toml[section]) continue;
      for (const key of Object.keys(toml[section])) {
        if (!(key in DEFAULTS[section])) {
          this.warnings.push(`Unknown option [${section}].${key} in config/config.toml - ignored.`);
          continue;
        }
        knownToml[section][key] = toml[section][key];
      }
    }
    for (const section of Object.keys(toml)) {
      if (!(section in DEFAULTS)) this.warnings.push(`Unknown section [${section}] in config/config.toml - ignored.`);
    }

    this.values = deepMerge(structuredClone(DEFAULTS), knownToml);
    this.envOverrides = this.applyEnvOverrides(this.values, this.env);
    this.validate();
    this.derivePaths();
    if (this.errors.length) {
      const hint = this.versionHint
        ? `${this.versionHint} Then restart the panel.`
        : 'Fix config/config.toml (or the environment overrides) and restart the panel.';
      throw new ConfigError(`Invalid configuration:\n  - ${this.errors.join('\n  - ')}`, {
        hint,
        details: { errors: this.errors },
      });
    }
    this.loaded = true;
    this.emit('loaded', this.values);
    return this;
  }

  validate() {
    const v = this.values;
    const intField = (value, label, min, max) => {
      try {
        return asInt(value, label, { min, max });
      } catch (err) {
        this.errors.push(err.message);
        return null;
      }
    };

    // --- minecraft -------------------------------------------------------
    const mc = v.minecraft;
    if (!/^\d+\.\d+(\.\d+)?$/.test(String(mc.version))) this.errors.push(`[minecraft].version "${mc.version}" is not a valid Minecraft version.`);
    const pair = validateVersionPair(mc.version, mc.neoforge_version);
    if (!pair.ok) {
      this.errors.push(pair.error);
      if (pair.hint) this.versionHint = pair.hint;
    } else if (pair.warning) {
      this.warnings.push(pair.warning);
    }
    this.versionCheck = pair;
    this.requiredJava = javaRequirementFor(mc.version);

    intField(mc.port, '[minecraft].port', 1, 65535);
    intField(mc.min_ram_mb, '[minecraft].min_ram_mb', 256, 262144);
    mc.max_ram_mb = intField(mc.max_ram_mb, '[minecraft].max_ram_mb', 512, 262144) ?? mc.max_ram_mb;
    if (mc.min_ram_mb > mc.max_ram_mb) {
      this.errors.push(`[minecraft].min_ram_mb (${mc.min_ram_mb}) cannot be larger than max_ram_mb (${mc.max_ram_mb}).`);
    }
    intField(mc.shutdown_timeout_s, '[minecraft].shutdown_timeout_s', 5, 1800);
    intField(mc.start_timeout_s, '[minecraft].start_timeout_s', 30, 3600);
    if (typeof mc.java_path !== 'string') this.errors.push('[minecraft].java_path must be a string.');
    if (mc.host && !HOSTS_OK.includes(String(mc.host)) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(mc.host))) {
      this.warnings.push(`[minecraft].host "${mc.host}" is unusual - expected an IP address or 0.0.0.0.`);
    }

    // --- admin mod -------------------------------------------------------
    const am = v.admin_mod;
    if (typeof am.source_dir !== 'string' || !am.source_dir.trim()) {
      this.errors.push('[admin_mod].source_dir must be a non-empty relative path.');
    }
    am.build_timeout_s = intField(am.build_timeout_s, '[admin_mod].build_timeout_s', 60, 7200) ?? am.build_timeout_s;
    am.build_xmx_mb = intField(am.build_xmx_mb, '[admin_mod].build_xmx_mb', 256, 16384) ?? am.build_xmx_mb;

    // --- servers ---------------------------------------------------------
    for (const [section, label] of [['admin', 'admin'], ['public', 'public']]) {
      intField(v[section].port, `[${section}].port`, 1, 65535);
      const host = String(v[section].host || '');
      if (!HOSTS_OK.includes(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
        this.errors.push(`[${section}].host "${host}" must be 127.0.0.1, 0.0.0.0, localhost or an IP address.`);
      }
      if (section === 'admin' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        this.warnings.push(`The admin panel is bound to ${host}: it is reachable from your network. Keep 127.0.0.1 unless you really need LAN access.`);
      }
      if (section === 'public' && ['127.0.0.1', 'localhost', '::1'].includes(host)) {
        this.warnings.push('The public page is bound to localhost only: Cloudflare Tunnel still works, but LAN devices cannot open it.');
      }
    }
    if (v.admin.port === v.public.port && !['127.0.0.1', 'localhost', '::1'].includes(String(v.admin.host))) {
      this.errors.push('[admin].port and [public].port must differ when both listen on non-loopback addresses.');
    }

    // --- e4mc ------------------------------------------------------------
    intField(v.e4mc.port, '[e4mc].port', 0, 65535);
    intField(v.e4mc.connect_timeout_s, '[e4mc].connect_timeout_s', 5, 600);
    if (v.e4mc.manual_address && !/^[A-Za-z0-9.-]+(:\d+)?$/.test(String(v.e4mc.manual_address))) {
      this.errors.push(`[e4mc].manual_address "${v.e4mc.manual_address}" is not a valid address (expected something like example.e4mc.link).`);
    }
    if (v.playit.address && !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(String(v.playit.address))) {
      this.errors.push(`[playit].address "${v.playit.address}" is not a valid hostname or host:port.`);
    }
    const playitPort = /:(\d+)$/.exec(String(v.playit.address || ''));
    if (playitPort && (Number(playitPort[1]) < 1 || Number(playitPort[1]) > 65535)) this.errors.push('[playit].address port must be between 1 and 65535.');
    if (typeof v.playit.agent_path !== 'string' || !v.playit.agent_path.trim()) this.errors.push('[playit].agent_path must be a non-empty path.');
    if (typeof v.playit.client_path !== 'string' || !v.playit.client_path.trim()) this.errors.push('[playit].client_path must be a non-empty path.');


    // --- cloudflare ------------------------------------------------------
    const cf = v.cloudflare;
    if (cf.domain && !HOSTNAME_RE.test(String(cf.domain).toLowerCase())) this.errors.push(`[cloudflare].domain "${cf.domain}" is not a valid domain name.`);
    if (cf.public_hostname && !HOSTNAME_RE.test(String(cf.public_hostname).toLowerCase())) {
      this.errors.push(`[cloudflare].public_hostname "${cf.public_hostname}" is not a valid hostname.`);
    }
    if (cf.enabled && !cf.domain && !cf.public_hostname) {
      this.errors.push('[cloudflare] is enabled but neither domain nor public_hostname is set.');
    }
    if (cf.enabled && cf.public_hostname && cf.domain && !String(cf.public_hostname).endsWith(String(cf.domain))) {
      this.warnings.push(`[cloudflare].public_hostname (${cf.public_hostname}) is not inside [cloudflare].domain (${cf.domain}) - make sure the DNS record exists in that zone.`);
    }
    if (cf.zone_id && !/^[a-f0-9]{32}$/i.test(String(cf.zone_id))) this.errors.push('[cloudflare].zone_id must be a 32 character hexadecimal zone id.');
    if (cf.api_token && String(cf.api_token).length < 20) this.warnings.push('[cloudflare].api_token looks too short - Cloudflare API tokens are usually 40 characters.');
    if (cf.tunnel_enabled && !cf.enabled) {
      this.warnings.push('[cloudflare].tunnel_enabled is set while [cloudflare].enabled is false - the tunnel will not be started.');
    }
    if (cf.enabled && !cf.tunnel_enabled) {
      this.warnings.push('[cloudflare] is enabled but tunnel_enabled is false: the public page will only be reachable locally. Enable the tunnel (or point your own proxy at public.port).');
    }

    // --- discord / restart / monitor ------------------------------------
    const dc = v.discord;
    if (dc.enabled && !String(dc.webhook_url || '').trim()) {
      this.errors.push('[discord] is enabled but webhook_url is empty: create a webhook in your Discord server (channel settings -> Integrations -> Webhooks) and paste it here.');
    }
    if (dc.webhook_url && !DISCORD_WEBHOOK_RE.test(String(dc.webhook_url).trim())) {
      this.errors.push(`[discord].webhook_url is not a Discord webhook URL (expected https://discord.com/api/webhooks/...).`);
    }
    if (dc.webhook_url && !/^https:\/\//i.test(String(dc.webhook_url).trim())) {
      this.errors.push('[discord].webhook_url must use HTTPS: the webhook URL is a secret and must never travel in clear text.');
    }
    const unknownEvents = (dc.events || []).filter((name) => !DISCORD_EVENT_NAMES.includes(name));
    if (unknownEvents.length) this.errors.push(`[discord].events contains unknown event(s): ${unknownEvents.join(', ')}. Accepted: ${DISCORD_EVENT_NAMES.join(', ')}.`);
    if (!Array.isArray(dc.events) || dc.events.length === 0) this.warnings.push('[discord].events is empty: nothing will be posted.');
    if (dc.mention_role_id && !/^\d{16,20}$/.test(String(dc.mention_role_id).trim())) {
      this.errors.push('[discord].mention_role_id must be the numeric id of a Discord role (16 to 20 digits).');
    }

    const rt = v.restart;
    if (rt.enabled && (!Array.isArray(rt.times) || rt.times.length === 0)) {
      this.errors.push('[restart] is enabled but times is empty: add at least one time, for example ["04:00"].');
    }
    for (const time of rt.times || []) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time).trim())) {
        this.errors.push(`[restart].times "${time}" is not a valid 24h time (expected HH:MM, for example 04:00).`);
      }
    }
    const warns = Array.isArray(rt.warn_minutes) ? rt.warn_minutes.map((n) => Number(n)) : [];
    if (warns.some((n) => !Number.isFinite(n) || n < 0 || n > 1440)) {
      this.errors.push('[restart].warn_minutes must be whole numbers of minutes between 0 and 1440.');
    }

    const mo = v.monitor;
    intField(mo.mspt_alert_ms, '[monitor].mspt_alert_ms', 20, 20000);
    intField(mo.mspt_sustain_min, '[monitor].mspt_sustain_min', 1, 1440);
    intField(mo.alert_cooldown_min, '[monitor].alert_cooldown_min', 1, 1440);
    if (mo.mspt_alert_ms <= 50) {
      this.warnings.push(`[monitor].mspt_alert_ms is ${mo.mspt_alert_ms} ms: a healthy server runs at 50 ms per tick (20 TPS), so this will alert constantly.`);
    }

    // --- files / backups / logging / security ---------------------------
    intField(v.files.max_upload_mb, '[files].max_upload_mb', 1, 8192);
    intField(v.files.max_edit_kb, '[files].max_edit_kb', 1, 65536);
    intField(v.backups.keep_last, '[backups].keep_last', 0, 10000);
    intField(v.backups.auto_backup_interval_h, '[backups].auto_backup_interval_h', 0, 8760);
    if (!Array.isArray(v.backups.include) || v.backups.include.length === 0) this.errors.push('[backups].include must list at least one file or folder.');

    const logLevels = ['debug', 'info', 'warn', 'error'];
    if (!logLevels.includes(v.logging.level)) this.errors.push(`[logging].level must be one of: ${logLevels.join(', ')}.`);
    intField(v.logging.max_file_mb, '[logging].max_file_mb', 1, 1024);
    intField(v.logging.max_files, '[logging].max_files', 1, 50);

    const sec = v.security;
    intField(sec.session_ttl_h, '[security].session_ttl_h', 1, 720);
    intField(sec.session_idle_min, '[security].session_idle_min', 5, 10080);
    intField(sec.login_max_attempts, '[security].login_max_attempts', 1, 100);
    intField(sec.login_window_min, '[security].login_window_min', 1, 1440);
    intField(sec.generated_password_length, '[security].generated_password_length', 12, 128);
    if (!['auto', 'always', 'never'].includes(sec.cookie_secure)) this.errors.push('[security].cookie_secure must be auto, always or never.');

    return this;
  }

  derivePaths() {
    const root = this.projectRoot;
    const abs = (p, fallback) => {
      const value = p && String(p).trim() ? String(p).trim() : fallback;
      return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    };
    this.paths = {
      projectRoot: root,
      configDir: path.join(root, 'config'),
      configFile: this.configFile,
      logsDir: abs(this.values.logging.dir, 'logs'),
      backupsDir: abs(this.values.backups.dir, 'backups'),
      minecraftRoot: path.join(root, 'minecraft'),
      serverDir: abs(this.values.minecraft.server_dir, 'minecraft/server'),
      launcherDir: abs(this.values.e4mc.jar_path, 'minecraft/launcher/e4mcbiat.jar').replace(/[\\/][^\\/]*$/, ''),
      e4mcJar: abs(this.values.e4mc.jar_path, 'minecraft/launcher/e4mcbiat.jar'),
      cloudflareDir: path.join(root, 'minecraft', 'launcher', 'cloudflared'),
      panelDir: path.join(root, 'panel'),
      publicDir: path.join(root, 'public'),
      runDir: path.join(root, 'run'),
      authFile: path.join(root, 'config', 'auth.json'),
      publicContentFile: path.join(root, 'config', 'public-content.json'),
      stateFile: path.join(root, 'config', '.panel-state.json'),
      dataDir: path.join(root, 'config', 'data'),
    };
    // effective e4mc tunnel port
    this.e4mcPort = this.values.e4mc.port && this.values.e4mc.port > 0 ? this.values.e4mc.port : this.values.minecraft.port;
    // file manager sandbox root
    this.fileRoot = this.values.files.root && String(this.values.files.root).trim()
      ? abs(this.values.files.root, 'minecraft/server')
      : this.paths.serverDir;
    this.maxUploadBytes = this.values.files.max_upload_mb * 1024 * 1024;
    this.maxEditBytes = this.values.files.max_edit_kb * 1024;
    return this.paths;
  }

  start() {
    loadDotEnv(path.join(this.projectRoot, '.env'));
    this.envOverrides = this.applyEnvOverrides(this.values, this.env);
    this.load();
    return this;
  }

  get(p, fallback = undefined) {
    const parts = String(p).split('.');
    let current = this.values;
    for (const part of parts) {
      if (current === undefined || current === null) return fallback;
      current = current[part];
    }
    return current === undefined ? fallback : current;
  }

  /** Configuration safe to display in the UI: credentials are masked. */
  toPublicJson() {
    const clone = structuredClone(this.values);
    if (clone.cloudflare.api_token) clone.cloudflare.api_token = clone.cloudflare.api_token ? '********' : '';
    if (clone.discord?.webhook_url) clone.discord.webhook_url = '********';
    if (clone.public?.wake_code) clone.public.wake_code = '********';
    return {
      values: clone,
      paths: { ...this.paths, authFile: undefined },
      requiredJava: this.requiredJava,
      warnings: this.warnings,
      createdFile: Boolean(this.createdFile),
      envOverrides: this.envOverrides,
    };
  }

  /**
   * Persist a patch into config/config.toml (comments preserved) and reload.
   * Restart-required keys are reported back to the caller.
   */
  async update(patch, { reload = true } = {}) {
    const flat = [];
    for (const [section, entries] of Object.entries(patch || {})) {
      if (!(section in DEFAULTS)) throw new AppError(`Unknown configuration section [${section}].`, { code: 'VALIDATION_ERROR', status: 400 });
      for (const [key, value] of Object.entries(entries || {})) {
        if (!(key in DEFAULTS[section])) throw new AppError(`Unknown configuration option [${section}].${key}.`, { code: 'VALIDATION_ERROR', status: 400 });
        if (section === 'security' && key === 'generated_password_length' && Number(value) < 12) {
          throw new AppError('The generated password length must be at least 12.', { code: 'VALIDATION_ERROR', status: 400 });
        }
        flat.push({ section, key, value });
      }
    }
    let text = fs.existsSync(this.configFile) ? fs.readFileSync(this.configFile, 'utf8') : '';
    for (const { section, key, value } of flat) text = updateTomlDocument(text, section, key, value);
    await writeFileAtomic(this.configFile, text, 'utf8');

    if (!reload) return { applied: flat.map((f) => `${f.section}.${f.key}`), restartRequired: [] };

    const previous = structuredClone(this.values);
    try {
      this.reload();
    } catch (err) {
      // Roll back the file so a bad edit cannot brick the panel.
      const rollback = [];
      for (const { section, key } of flat) rollback.push({ section, key, value: previous[section][key] });
      let rollbackText = fs.readFileSync(this.configFile, 'utf8');
      for (const { section, key, value } of rollback) rollbackText = updateTomlDocument(rollbackText, section, key, value);
      await writeFileAtomic(this.configFile, rollbackText, 'utf8');
      this.values = previous;
      this.derivePaths();
      throw err;
    }

    const restartRequired = [];
    const check = (pathKey, label) => {
      const before = previous;
      const [s, k] = pathKey.split('.');
      if (JSON.stringify(before[s][k]) !== JSON.stringify(this.values[s][k])) restartRequired.push(label);
    };
    check('admin.host', 'The admin panel host');
    check('admin.port', 'The admin panel port');
    check('public.enabled', 'The public page');
    check('public.host', 'The public page host');
    check('public.port', 'The public page port');
    check('logging.dir', 'The log directory');
    check('backups.dir', 'The backup directory');
    check('files.root', 'The file manager root');
    if (JSON.stringify(previous.minecraft) !== JSON.stringify(this.values.minecraft)) restartRequired.push('The Minecraft server settings (restart the server to apply)');
    if (JSON.stringify(previous.e4mc) !== JSON.stringify(this.values.e4mc)) restartRequired.push('The e4mc settings (restart the server to apply)');
    if (JSON.stringify(previous.cloudflare) !== JSON.stringify(this.values.cloudflare)) restartRequired.push('The Cloudflare settings (restart the tunnel to apply)');

    this.emit('change', this.values);
    return { applied: flat.map((f) => `${f.section}.${f.key}`), restartRequired: [...new Set(restartRequired)] };
  }

  reload() {
    this.load();
    return this;
  }

  /** Content of the public page (not secrets, but kept out of the TOML file). */
  readPublicContent(defaults = {}) {
    const fallback = {
      name: this.values.server.name,
      description: 'A modded Minecraft server hosted locally.',
      rules: ['Be respectful.', 'No griefing.', 'Have fun!'],
      discord: '',
      website: '',
      accent: '#3ba55d',
      ...defaults,
    };
    const fromFile = readJsonSync(this.paths.publicContentFile, null);
    return { ...fallback, ...(fromFile || {}) };
  }
}

let singleton = null;

export function getConfig(options = {}) {
  if (!singleton) singleton = new Config(options);
  return singleton;
}

export function resetConfigSingleton() {
  singleton = null;
}
