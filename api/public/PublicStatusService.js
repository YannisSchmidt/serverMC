/**
 * PublicStatusService - the strict PUBLIC API projection.
 *
 * This module is the only place allowed to build the payload served on
 * /api/public/*. It copies an explicit whitelist of fields and nothing else:
 * no paths, no IPs, no logs, no tokens, no configuration, no error internals.
 * tests/public-api.test.js asserts that the payload cannot leak a new field by
 * accident (deep key whitelist).
 */

import { JsonStore } from '../util/jsonstore.js';
import { ValidationError } from '../util/errors.js';
import { humanBytes } from '../util/fsx.js';

/** Fields that are allowed to appear in the public payload (deep whitelist). */
export const PUBLIC_STATUS_ALLOWED_KEYS = new Set([
  'server', 'name', 'online', 'state', 'status', 'minecraft_version', 'neoforge_version',
  'players', 'max', 'list', 'e4mc', 'address', 'address_source', 'port', 'version',
  'updated_at', 'uptime_seconds', 'started_at', 'motd', 'description', 'rules', 'links',
  'discord', 'website', 'last_update', 'latency_ms', 'checked_at',
]);

export class PublicStatusService {
  constructor({ config, logs, minecraft, e4mc, cloudflare, playit = null, events }) {
    this.config = config;
    this.log = logs.application.child('public');
    this.minecraft = minecraft;
    this.e4mc = e4mc;
    this.cloudflare = cloudflare;
    this.playit = playit;
    this.events = events;
    this.content = new JsonStore(config.paths.publicContentFile, this.defaultContent());
    this.startedAt = new Date().toISOString();
  }

  defaultContent() {
    return {
      name: this.config.values.server.name,
      description: 'A Minecraft server hosted at home. Join with the address below.',
      rules: ['Be respectful to other players.', 'No griefing or stealing.', 'Have fun!'],
      discord: '',
      website: '',
    };
  }

  async start() {
    await this.content.load();
    return this;
  }

  async updateContent(patch) {
    const allowed = ['name', 'description', 'rules', 'discord', 'website'];
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (!allowed.includes(key)) continue;
      if (key === 'rules') {
        if (!Array.isArray(value)) continue;
        clean.rules = value.map((r) => String(r).slice(0, 300)).filter(Boolean).slice(0, 30);
      } else if (key === 'description') {
        clean.description = String(value).slice(0, 2000);
      } else if (key === 'discord' || key === 'website') {
        const str = String(value).trim().slice(0, 300);
        if (str && !/^https?:\/\/[^\s]+$/i.test(str)) {
          throw new ValidationError(`${key} must be a full URL starting with http:// or https://`, { code: 'VALIDATION_ERROR' });
        }
        clean[key] = str;
      } else {
        clean[key] = String(value).slice(0, 120);
      }
    }
    this.content.set(clean);
    await this.content.flush();
    this.events?.publish('settings', { publicContent: this.content.get() });
    return this.content.get();
  }

  /**
   * Build the public status payload.
   * @param {{includeContent?: boolean}} options
   */
  status({ includeContent = true } = {}) {
    const mc = this.minecraft.status();
    const e4mcStatus = this.e4mc.status();
    const playitStatus = this.playit?.status();
    const content = this.content.get();
    const publicAddress = (playitStatus?.enabled && playitStatus.address) || e4mcStatus.address || null;
    const addressSource = playitStatus?.enabled && playitStatus.address ? 'playit' : (e4mcStatus.addressSource || null);

    const payload = {
      server: content.name || this.config.values.server.name,
      online: mc.state === 'online',
      state: mc.state,
      minecraft_version: this.config.values.minecraft.version,
      neoforge_version: this.config.values.minecraft.neoforge_version,
      players: {
        online: mc.players.online,
        max: mc.players.max ?? null,
      },
      e4mc: {
        online: Boolean(mc.state === 'online' && ((addressSource === 'playit' && playitStatus?.running) || (addressSource !== 'playit' && e4mcStatus.online))),
        address: publicAddress,
        address_source: addressSource,
      },
      updated_at: new Date().toISOString(),
      uptime_seconds: mc.uptimeS || 0,
      started_at: mc.startedAt || null,
    };

    if (includeContent) {
      payload.description = content.description || '';
      payload.rules = Array.isArray(content.rules) ? content.rules : [];
      payload.links = {
        discord: content.discord || null,
        website: content.website || null,
      };
    }
    return this.sanitize(payload);
  }

  /** Recursively drop any key that is not whitelisted and any private value. */
  sanitize(value, depth = 0) {
    if (depth > 6) return null;
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? this.sanitize(v, depth + 1) : this.scrubPrimitive(v)));
    if (typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!PUBLIC_STATUS_ALLOWED_KEYS.has(key)) continue;
        out[key] = this.sanitize(entry, depth + 1);
      }
      return out;
    }
    return this.scrubPrimitive(value);
  }

  /** Remove anything that looks like a filesystem path, an IP or a secret. */
  scrubPrimitive(value) {
    if (typeof value !== 'string') return value;
    if (/[A-Za-z]:\\|\/(?:home|Users|root|mnt|opt)\//.test(value)) {
      this.log.debug('Removed a path-like value from the public payload.');
      return null;
    }
    if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(value) && !/\.e4mc\.link/.test(value)) {
      this.log.debug('Removed an IP-like value from the public payload.');
      return null;
    }
    return value;
  }

  /** Extra public data for the dashboard card of the public page. */
  summary() {
    const status = this.status();
    return {
      ...status,
      limits: {
        maxPlayers: this.minecraft.status().players.max,
      },
      storage: null,
    };
  }

  /** Content as edited in the admin panel (not sanitized the same way). */
  contentForAdmin() {
    return {
      ...this.content.get(),
      diskSize: humanBytes(JSON.stringify(this.content.get()).length),
    };
  }
}
