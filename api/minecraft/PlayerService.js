/**
 * PlayerService - who is online, who is known, and every player action.
 *
 * Data sources (all real files produced by the vanilla server):
 *   - live console parsing (`x joined the game` / `list` responses)
 *   - usercache.json         (name <-> UUID)
 *   - whitelist.json / ops.json / banned-players.json
 *   - world/playerdata/<uuid>.dat timestamps (first/last seen)
 *   - config/data/player-history.json (history recorded by the panel itself)
 *
 * Actions are executed as Minecraft console commands - never as shell commands.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { JsonStore } from '../util/jsonstore.js';
import { readJson, statOrNull } from '../util/fsx.js';
import { assertUsername, mcQuote } from '../util/validate.js';
import { AppError } from '../util/errors.js';

export class PlayerService {
  constructor({ config, logs, minecraft, events }) {
    this.config = config;
    this.log = logs.application.child('players');
    this.minecraft = minecraft;
    this.events = events;
    this.history = new JsonStore(path.join(config.paths.dataDir, 'player-history.json'), { players: {} });
    this.historyLoaded = false;
    this.cache = { at: 0, data: null };
  }

  get serverDir() {
    return this.config.paths.serverDir;
  }

  file(name) {
    return path.join(this.serverDir, name);
  }

  async init() {
    if (!this.historyLoaded) {
      await this.history.load();
      this.historyLoaded = true;
    }
    return this;
  }

  /** Index of known players built from usercache + json files + history. */
  async knownPlayers({ force = false } = {}) {
    if (!force && this.cache.data && Date.now() - this.cache.at < 5000) return this.cache.data;
    await this.init();
    const [usercache, whitelist, ops, banned] = await Promise.all([
      readJson(this.file('usercache.json'), []),
      readJson(this.file('whitelist.json'), null),
      readJson(this.file('ops.json'), null),
      readJson(this.file('banned-players.json'), null),
    ]);

    const map = new Map();
    const ensure = (name, uuid = null) => {
      const key = (name || '').toLowerCase();
      if (!key) return null;
      if (!map.has(key)) {
        map.set(key, { name, uuid: uuid || null, whitelisted: false, op: false, banned: false, firstSeen: null, lastSeen: null, online: false, playtimeS: null });
      }
      const entry = map.get(key);
      if (uuid && !entry.uuid) entry.uuid = uuid;
      return entry;
    };

    for (const entry of Array.isArray(usercache) ? usercache : []) {
      if (entry?.name) ensure(entry.name, entry.uuid);
    }
    for (const entry of Array.isArray(whitelist) ? whitelist : []) {
      const target = ensure(entry?.name, entry?.uuid);
      if (target) target.whitelisted = true;
    }
    for (const entry of Array.isArray(ops) ? ops : []) {
      const target = ensure(entry?.name, entry?.uuid);
      if (target) {
        target.op = true;
        target.opLevel = entry.level ?? 4;
      }
    }
    for (const entry of Array.isArray(banned) ? banned : []) {
      const target = ensure(entry?.name, entry?.uuid);
      if (target) {
        target.banned = true;
        target.banReason = entry.reason || '';
        target.banExpires = entry.expires || 'forever';
        target.bannedBy = entry.source || 'unknown';
      }
    }

    const history = this.history.get('players') || {};
    for (const [key, value] of Object.entries(history)) {
      const target = ensure(value.name || key, value.uuid);
      if (target) {
        target.firstSeen = value.firstSeen || target.firstSeen;
        target.lastSeen = value.lastSeen || target.lastSeen;
        target.joins = value.joins ?? 0;
      }
    }

    // player data files give real first/last activity timestamps
    const playerdataDir = path.join(this.serverDir, 'world', 'playerdata');
    let datFiles = [];
    try {
      datFiles = (await fsp.readdir(playerdataDir)).filter((f) => f.endsWith('.dat'));
    } catch {
      datFiles = [];
    }
    for (const file of datFiles) {
      const uuid = file.replace(/\.dat$/, '');
      const stat = await statOrNull(path.join(playerdataDir, file));
      if (!stat) continue;
      let entry = [...map.values()].find((p) => p.uuid === uuid) || null;
      if (!entry) {
        // A player we only know by UUID (usercache is capped at 1000 entries).
        entry = { name: null, uuid, whitelisted: false, op: false, banned: false, firstSeen: null, lastSeen: null, online: false };
        map.set(uuid, entry);
      }
      const first = new Date(Math.min(stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs)).toISOString();
      const last = new Date(stat.mtimeMs).toISOString();
      entry.firstSeen = entry.firstSeen && entry.firstSeen < first ? entry.firstSeen : first;
      entry.lastSeen = entry.lastSeen && entry.lastSeen > last ? entry.lastSeen : last;
    }

    // The panel's own history is the most accurate "seen online" source.
    for (const [key, value] of Object.entries(history)) {
      const entry = map.get(key) || map.get((value.uuid || '').toLowerCase());
      if (!entry) continue;
      if (value.lastSeen && (!entry.lastSeen || value.lastSeen > entry.lastSeen)) entry.lastSeen = value.lastSeen;
      if (value.firstSeen && (!entry.firstSeen || value.firstSeen < entry.firstSeen)) entry.firstSeen = value.firstSeen;
    }

    const online = new Set(this.currentlyOnline().map((n) => n.toLowerCase()));
    const players = [...map.values()].map((p) => ({ ...p, online: p.name ? online.has(p.name.toLowerCase()) : false }));
    const data = {
      players: players.sort((a, b) => (b.online - a.online) || String(a.name || a.uuid).localeCompare(String(b.name || b.uuid))),
      counts: {
        known: players.length,
        online: players.filter((p) => p.online).length,
        whitelisted: players.filter((p) => p.whitelisted).length,
        ops: players.filter((p) => p.op).length,
        banned: players.filter((p) => p.banned).length,
      },
      files: {
        usercache: Boolean(usercache),
        whitelist: whitelist !== null,
        ops: ops !== null,
        banned: banned !== null,
      },
      readAt: new Date().toISOString(),
    };
    this.cache = { at: Date.now(), data };
    return data;
  }

  currentlyOnline() {
    try {
      return this.minecraft?.parser?.snapshot().players || [];
    } catch {
      return [];
    }
  }

  /** Record a join/leave observed in the console (persisted history). */
  recordJoin(name) {
    if (!name) return;
    this.record(name, 'join');
    this.events?.publish('players', { action: 'history', player: name });
  }

  recordLeave(name) {
    if (!name) return;
    this.record(name, 'leave');
    this.events?.publish('players', { action: 'history', player: name });
  }

  record(name, kind) {
    const key = String(name).toLowerCase();
    const players = this.history.get('players') || {};
    const entry = players[key] || { name, uuid: null, firstSeen: null, lastSeen: null, joins: 0 };
    const now = new Date().toISOString();
    entry.name = name;
    if (!entry.firstSeen) entry.firstSeen = now;
    if (kind === 'join') {
      entry.lastSeen = now;
      entry.joins = (entry.joins || 0) + 1;
    } else {
      entry.lastLeave = now;
    }
    players[key] = entry;
    this.history.set('players', players);
    this.cache.at = 0;
  }

  async setUuid(name, uuid) {
    const key = String(name).toLowerCase();
    const players = this.history.get('players') || {};
    if (players[key]) {
      players[key].uuid = uuid;
      this.history.set('players', players);
    }
  }

  // ------------------------------------------------------------- actions

  /**
   * Execute a player action through the Minecraft console.
   * Usernames are validated (letters, digits, underscore, 16 chars max) so a
   * crafted name can never inject an extra console command.
   */
  async action(action, payload = {}) {
    await this.init();
    const name = assertUsername(payload.player || payload.name, 'player');
    const reason = mcQuote(payload.reason || '', { max: 120 });
    let command;
    switch (action) {
      case 'kick':
        command = `kick ${name}${reason ? ` ${reason}` : ''}`;
        break;
      case 'ban':
        command = `ban ${name}${reason ? ` ${reason}` : ''}`;
        break;
      case 'unban':
        command = `pardon ${name}`;
        break;
      case 'whitelist_add':
        command = `whitelist add ${name}`;
        break;
      case 'whitelist_remove':
        command = `whitelist remove ${name}`;
        break;
      case 'op':
        command = `op ${name}`;
        break;
      case 'deop':
        command = `deop ${name}`;
        break;
      case 'message':
      case 'tell': {
        const message = mcQuote(payload.message || '', { max: 200 });
        if (!message) throw new AppError('The message must not be empty.', { code: 'VALIDATION_ERROR', status: 400 });
        command = `tell ${name} ${message}`;
        break;
      }
      default:
        throw new AppError(`Unknown player action "${action}".`, { code: 'UNKNOWN_ACTION', status: 400 });
    }
    const result = this.minecraft.sendCommand(command);
    this.log.info(`Player action ${action} -> "${command}"`);
    this.cache.at = 0;
    // Give the server a moment, then refresh server-side lists.
    setTimeout(() => this.refresh().catch(() => {}), 400);
    return { ...result, action, player: name };
  }

  async refresh() {
    if (this.minecraft?.state === 'online') {
      try {
        this.minecraft.sendCommand('list', { echo: false });
      } catch {
        /* ignore */
      }
    }
    // The json files are rewritten by the server right after the command.
    await new Promise((r) => setTimeout(r, 250));
    return this.knownPlayers({ force: true });
  }

  /** Bootstrap files the panel needs before the server has ever run. */
  async ensureDefaultFiles() {
    const targets = [
      ['whitelist.json', []],
    ];
    for (const [name, value] of targets) {
      const file = this.file(name);
      const stat = await statOrNull(file);
      if (!stat) await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8').catch(() => {});
    }
  }
}
