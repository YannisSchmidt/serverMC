/**
 * server.properties reader/writer (Java properties format).
 *
 * Comments, key order and unknown keys are preserved: the panel edits single
 * values instead of regenerating the file, so a hand-tuned file stays intact.
 */

import fsp from 'node:fs/promises';
import { ValidationError } from '../util/errors.js';
import { writeFileAtomic } from '../util/fsx.js';

const KNOWN_KEYS = {
  'server-port': { type: 'int', min: 1, max: 65535, label: 'Server port' },
  'server-ip': { type: 'string', max: 64, label: 'Bind address' },
  'max-players': { type: 'int', min: 1, max: 10000, label: 'Max players' },
  'online-mode': { type: 'bool', label: 'Online mode (Mojang authentication)' },
  motd: { type: 'string', max: 256, label: 'Message of the day' },
  difficulty: { type: 'enum', values: ['peaceful', 'easy', 'normal', 'hard'], label: 'Difficulty' },
  gamemode: { type: 'enum', values: ['survival', 'creative', 'adventure', 'spectator'], label: 'Game mode' },
  'pvp': { type: 'bool', label: 'PvP' },
  'white-list': { type: 'bool', label: 'Whitelist' },
  'enable-command-block': { type: 'bool', label: 'Command blocks' },
  'view-distance': { type: 'int', min: 3, max: 32, label: 'View distance' },
  'simulation-distance': { type: 'int', min: 3, max: 32, label: 'Simulation distance' },
  'spawn-protection': { type: 'int', min: 0, max: 1000, label: 'Spawn protection' },
  'level-name': { type: 'string', max: 64, label: 'World folder' },
  'level-seed': { type: 'string', max: 128, label: 'World seed' },
  'level-type': { type: 'string', max: 128, label: 'World type' },
  'max-tick-time': { type: 'int', min: -1, max: 3600000, label: 'Max tick time (ms)' },
  'allow-flight': { type: 'bool', label: 'Allow flight' },
  'allow-nether': { type: 'bool', label: 'Allow Nether' },
  'enable-rcon': { type: 'bool', label: 'Enable RCON' },
  'enforce-whitelist': { type: 'bool', label: 'Enforce whitelist' },
  'player-idle-timeout': { type: 'int', min: 0, max: 1440, label: 'Idle timeout (min)' },
  'network-compression-threshold': { type: 'int', min: -1, max: 65535, label: 'Compression threshold' },
};

export const DEFAULT_PROPERTIES = {
  'server-port': null, // filled from config
  'server-ip': '', // keep empty: bind to all interfaces (configurable)
  'max-players': 20,
  'online-mode': true,
  motd: 'A NeoForge 1.21.1 server',
  difficulty: 'normal',
  gamemode: 'survival',
  'level-name': 'world',
  'view-distance': 10,
  'simulation-distance': 8,
  'spawn-protection': 16,
  pvp: true,
  'white-list': false,
  'enforce-whitelist': false,
  'allow-flight': false,
  'allow-nether': true,
  'enable-command-block': false,
  'enable-rcon': false,
  'max-tick-time': 60000,
  'player-idle-timeout': 0,
  'network-compression-threshold': 256,
};

export const HEADER = `# Minecraft server properties
# Managed by the local panel - comments and unknown keys are preserved.
# Changing server-port/max-players here requires a server restart.
`;

export class ServerProperties {
  constructor(file) {
    this.file = file;
    this.entries = []; // { type: 'comment'|'blank'|'pair', raw, key, value }
    this.loaded = false;
  }

  async load() {
    let text = '';
    try {
      text = await fsp.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.entries = [];
      this.loaded = true;
      return this;
    }
    this.entries = text.split(/\r?\n/).map((line) => {
      if (!line.trim()) return { type: 'blank', raw: line };
      if (/^\s*[#!]/.test(line)) return { type: 'comment', raw: line };
      const sep = line.indexOf('=');
      if (sep === -1) return { type: 'comment', raw: line };
      return { type: 'pair', raw: line, key: line.slice(0, sep).trim(), value: line.slice(sep + 1) };
    });
    this.loaded = true;
    return this;
  }

  toObject() {
    const out = {};
    for (const entry of this.entries) {
      if (entry.type === 'pair') out[entry.key] = entry.value;
    }
    return out;
  }

  get(key, fallback = undefined) {
    const entry = this.entries.find((e) => e.type === 'pair' && e.key === key);
    return entry ? entry.value : fallback;
  }

  getInt(key, fallback = null) {
    const raw = this.get(key);
    const num = Number(raw);
    return Number.isFinite(num) ? num : fallback;
  }

  getBool(key, fallback = false) {
    const raw = this.get(key);
    if (raw === undefined) return fallback;
    return String(raw).toLowerCase() === 'true';
  }

  set(key, value) {
    const entry = this.entries.find((e) => e.type === 'pair' && e.key === key);
    const rendered = `${key}=${typeof value === 'boolean' ? String(value) : value}`;
    if (entry) {
      entry.value = typeof value === 'boolean' ? String(value) : String(value);
      entry.raw = rendered;
    } else {
      this.entries.push({ type: 'pair', raw: rendered, key, value: String(value) });
    }
    return this;
  }

  /** Fill in the keys the panel manages, without touching existing values. */
  applyDefaults(defaults = DEFAULT_PROPERTIES, { overwrite = false } = {}) {
    for (const [key, value] of Object.entries(defaults)) {
      if (value === null || value === undefined) continue;
      const exists = this.entries.some((e) => e.type === 'pair' && e.key === key);
      if (!exists || overwrite) this.set(key, value);
    }
    return this;
  }

  /** Validate a single key/value pair coming from the UI. */
  validate(key, value) {
    const spec = KNOWN_KEYS[key];
    if (!spec) {
      if (!/^[a-z0-9.\-]{1,64}$/.test(key)) throw new ValidationError('Invalid properties key name.');
      return String(value).slice(0, 512);
    }
    if (spec.type === 'int') {
      const num = Number(String(value).trim());
      if (!Number.isInteger(num) || num < spec.min || num > spec.max) {
        throw new ValidationError(`"${key}" must be an integer between ${spec.min} and ${spec.max}.`);
      }
      return String(num);
    }
    if (spec.type === 'bool') {
      const str = String(value).trim().toLowerCase();
      if (!['true', 'false'].includes(str)) throw new ValidationError(`"${key}" must be true or false.`);
      return str;
    }
    if (spec.type === 'enum') {
      const str = String(value).trim().toLowerCase();
      if (!spec.values.includes(str)) throw new ValidationError(`"${key}" must be one of: ${spec.values.join(', ')}.`);
      return str;
    }
    const str = String(value);
    if (str.length > (spec.max || 512)) throw new ValidationError(`"${key}" is too long (max ${spec.max} characters).`);
    if (/[\r\n\0]/.test(str)) throw new ValidationError(`"${key}" must not contain line breaks.`);
    return str;
  }

  /** Apply several validated values at once. */
  applyValues(values) {
    for (const [key, value] of Object.entries(values || {})) {
      this.set(key, this.validate(key, value));
    }
    return this;
  }

  async save() {
    // The file starts with HEADER, which we read back as ordinary comments:
    // skip that leading copy so saving twice never stacks headers.
    const headerLines = new Set(HEADER.split('\n').filter(Boolean));
    let start = 0;
    while (start < this.entries.length) {
      const entry = this.entries[start];
      const isHeader = entry.type === 'comment' && headerLines.has(entry.raw);
      if (isHeader || entry.type === 'blank') {
        start += 1;
        continue;
      }
      break;
    }
    const body = this.entries.slice(start).map((e) => e.raw).join('\n').replace(/\n+$/, '');
    await writeFileAtomic(this.file, `${HEADER}\n${body}\n`, 'utf8');
    return this;
  }

  /** Descriptor for the Settings UI: known keys with metadata + current values. */
  describe() {
    const current = this.toObject();
    return Object.entries(KNOWN_KEYS).map(([key, spec]) => ({
      key,
      label: spec.label,
      type: spec.type,
      values: spec.values,
      min: spec.min,
      max: spec.max,
      value: current[key] ?? null,
    }));
  }
}
