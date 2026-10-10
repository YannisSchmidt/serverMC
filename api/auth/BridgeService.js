/**
 * BridgeService - the local bridge between the panel and the in-game mod.
 *
 * The bundled admin mod (mods-src/admin-tools, the `/panel` command) runs
 * inside the Minecraft server and needs a way to ask the panel for the things
 * only the panel knows: the player history, the backup list, the mod list, the
 * e4mc address, or a server restart.
 *
 * Design
 *   - one random bearer token, stored in config/data/bridge-token.json (0600),
 *     created on first boot and rotatable on demand;
 *   - the token is accepted ONLY from a loopback TCP connection (the real
 *     socket address, never a forwarded header) and only on /api/admin/bridge/*;
 *   - it is never written to a log, never returned by any endpoint and never
 *     exposed to the browser: the CLI prints it once, and `--write-mod-config`
 *     copies it straight into the mod configuration file;
 *   - failed attempts are rate limited per IP like the login attempts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, ForbiddenError, RateLimitError, UnauthorizedError } from '../util/errors.js';
import { readJson, writeFileAtomic, ensureDir } from '../util/fsx.js';
import { isLoopbackAddress } from '../util/net.js';
import { RateLimiter } from './AuthService.js';

const TOKEN_BYTES = 32;
/** Key the mod reads in config/admintools.properties. */
export const MOD_CONFIG_KEY = 'panel.token';

export function generateBridgeToken() {
  return `bridge_${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class BridgeService {
  constructor({ config, logs }) {
    this.config = config;
    this.log = logs.application.child('bridge');
    this.tokenFile = path.join(this.config.paths.dataDir, 'bridge-token.json');
    /** Where the mod reads its configuration from. */
    this.modConfigFile = path.join(this.config.paths.serverDir, 'config', 'admintools.properties');
    this.limiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });
    this.state = null;
  }

  async start() {
    await this.load();
    return this;
  }

  async stop() {
    /* nothing to release: the token lives on disk */
  }

  async load() {
    const existing = await readJson(this.tokenFile, null);
    if (existing?.token) {
      this.state = existing;
      return this.state;
    }
    return this.rotate({ createdBy: 'first boot' });
  }

  /**
   * Create a new token. The previous one stops working immediately, which is
   * the point: the mod reloads its configuration on the next restart.
   */
  async rotate({ createdBy = 'manual rotation' } = {}) {
    const token = generateBridgeToken();
    const now = new Date().toISOString();
    this.state = {
      token,
      createdAt: now,
      rotatedAt: now,
      createdBy,
      lastUsedAt: null,
      lastUsedFrom: null,
      useCount: 0,
    };
    await ensureDir(path.dirname(this.tokenFile));
    await writeFileAtomic(this.tokenFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(this.tokenFile, 0o600).catch(() => {});
    this.log.warn(`Bridge token rotated (${createdBy}); the in-game /panel command needs the new token.`);
    return token;
  }

  /** The token itself: only the CLI prints it, no HTTP endpoint ever does. */
  token() {
    return this.state?.token || null;
  }

  /**
   * Everything the panel/doctor/UI may show. The token is deliberately absent.
   */
  status() {
    const mod = this.modConfigStatus();
    return {
      configured: Boolean(this.state?.token),
      tokenFile: this.tokenFile,
      createdAt: this.state?.createdAt || null,
      rotatedAt: this.state?.rotatedAt || null,
      lastUsedAt: this.state?.lastUsedAt || null,
      useCount: this.state?.useCount || 0,
      endpoints: ['GET /api/admin/bridge/ping', 'GET /api/admin/bridge/status', 'GET /api/admin/bridge/players',
        'GET /api/admin/bridge/player/:name', 'GET /api/admin/bridge/backups', 'POST /api/admin/bridge/backups',
        'GET /api/admin/bridge/mods', 'GET /api/admin/bridge/e4mc', 'POST /api/admin/bridge/server/:action'],
      modConfig: mod,
      linked: mod.present && mod.matches,
    };
  }

  /** Read the mod configuration file and compare its token with ours. */
  modConfigStatus() {
    const file = this.modConfigFile;
    return {
      file,
      present: fspStatSync(file),
      key: MOD_CONFIG_KEY,
      hasToken: hasModToken(file),
      matches: modTokenMatches(file, this.state?.token),
    };
  }

  /**
   * Validate a bridge request. `remoteAddress` must be the TCP peer address.
   */
  assertRequest({ token, remoteAddress, path: routePath = '' }) {
    if (!isLoopbackAddress(remoteAddress)) {
      // Never say what was refused beyond the fact that it is not local.
      throw new ForbiddenError('The mod bridge only accepts connections from this machine.', {
        code: 'BRIDGE_NOT_LOCAL',
        hint: `The /panel command must reach http://127.0.0.1:${this.config.values.admin.port} on the same PC.`,
        details: { route: routePath },
      });
    }
    const ip = String(remoteAddress || 'unknown');
    const limit = this.limiter.check(ip);
    if (!limit.allowed) {
      throw new RateLimitError('Too many bridge attempts from this address.', {
        code: 'BRIDGE_RATE_LIMITED',
        details: { retryAfterMs: limit.retryAfterMs, route: routePath },
      });
    }
    if (!this.state?.token) {
      throw new AppError('The bridge token does not exist yet.', {
        code: 'BRIDGE_NOT_CONFIGURED',
        status: 503,
        hint: 'Start the panel once, then run: node api/cli.js bridge-token --write-mod-config',
      });
    }
    if (!token || !safeEqual(token, this.state.token)) {
      const attempts = this.limiter.hit(ip);
      this.log.warn(`Rejected bridge request from ${ip} (attempt ${attempts}/${this.limiter.max}) on ${routePath || 'unknown route'}.`);
      throw new UnauthorizedError('Invalid bridge token.', {
        code: 'BRIDGE_TOKEN_INVALID',
        hint: 'Run "node api/cli.js bridge-token --write-mod-config" and restart the Minecraft server.',
        details: { attempts, max: this.limiter.max },
      });
    }
    this.limiter.reset(ip);
    this.state.useCount += 1;
    this.state.lastUsedAt = new Date().toISOString();
    this.state.lastUsedFrom = ip;
    // Persist the counters without blocking the request; a failure here is not
    // a reason to refuse the mod.
    writeFileAtomic(this.tokenFile, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    return true;
  }

  /**
   * Copy the token into the mod configuration file (server side only).
   *
   * The file is a plain Java properties file: the key is replaced in place when
   * it exists, appended otherwise, and everything else is preserved. The token
   * is never logged, never returned and never part of an API response.
   */
  async writeModConfig({ restartHint = true } = {}) {
    const token = this.state?.token || (await this.load()).token;
    if (!token) throw new AppError('No bridge token is configured.', { code: 'BRIDGE_NOT_CONFIGURED', status: 500 });
    const file = this.modConfigFile;
    await ensureDir(path.dirname(file));
    const current = await fsp.readFile(file, 'utf8').catch(() => null);
    const line = `${MOD_CONFIG_KEY}=${token}`;
    let next;
    if (current === null) {
      next = `# Written by the panel (node api/cli.js bridge-token --write-mod-config).\n${line}\n`;
    } else {
      const lines = current.split(/\r?\n/);
      const pattern = new RegExp(`^\\s*${MOD_CONFIG_KEY.replace('.', '\\.')}\\s*=`);
      let replaced = false;
      next = lines
        .map((existing) => {
          if (pattern.test(existing)) {
            replaced = true;
            return line;
          }
          return existing;
        })
        .join('\n');
      if (!replaced) next = `${next.replace(/\s*$/, '')}\n\n# ---- /panel bridge (written by the panel) --------------------------------\n${line}\n`;
    }
    await writeFileAtomic(file, next, { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => {});
    this.log.info('The bridge token was written into the mod configuration (config/admintools.properties).');
    return {
      file,
      message: restartHint
        ? 'Bridge token written to minecraft/server/config/admintools.properties. Restart the Minecraft server (or run /panel reload in game) to apply it.'
        : 'Bridge token written to minecraft/server/config/admintools.properties.',
    };
  }
}

// The two helpers below are synchronous on purpose: the panel reports the mod
// configuration state on every status call, and a missing file is the normal
// case (the mod was never installed).
function fspStatSync(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

function modConfigToken(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = new RegExp(`^\\s*${MOD_CONFIG_KEY.replace('.', '\\.')}\\s*=\\s*(.*)$`, 'm').exec(text);
    if (!match) return null;
    return match[1].trim();
  } catch {
    return null;
  }
}

function hasModToken(file) {
  const token = modConfigToken(file);
  return typeof token === 'string' && token.length > 0;
}

function modTokenMatches(file, token) {
  const stored = modConfigToken(file);
  return Boolean(token && stored) && safeEqual(stored, token);
}
