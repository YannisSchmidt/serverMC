/**
 * ModsService - inspect and manage the jars in minecraft/server/mods.
 *
 * Mod metadata is read from inside the jars (no execution, no extraction to
 * disk):
 *   NeoForge 1.20.5+  -> META-INF/neoforge.mods.toml
 *   Forge / NeoForge  -> META-INF/mods.toml
 *   Fabric            -> fabric.mod.json
 *   fallback          -> META-INF/MANIFEST.MF
 *
 * Declared Minecraft/NeoForge version ranges are compared with the configured
 * versions so the panel can tell "this mod will not load" *before* a restart.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import yauzl from 'yauzl';
import { parse as parseToml } from 'smol-toml';
import { AppError, ValidationError } from '../util/errors.js';
import { ensureDir, statOrNull, walk } from '../util/fsx.js';
import { PathSandbox } from '../util/paths.js';
import { compareVersions, parseVersion } from '../util/mcversions.js';
import { JsonStore } from '../util/jsonstore.js';

const MANIFEST_LIMIT = 512 * 1024; // mod metadata never needs more than this

/** Read selected text entries from a zip without extracting it. */
export function readZipEntries(file, wanted = [], { limit = MANIFEST_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    const found = {};
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) {
        reject(new AppError(`${path.basename(file)} is not a readable jar/zip archive: ${err.message}`, {
          code: 'INVALID_JAR', status: 400, hint: 'The file is corrupted or is not a mod jar.',
        }));
        return;
      }
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        resolve(found);
      };
      zipfile.on('error', (zipErr) => {
        if (finished) return;
        finished = true;
        reject(zipErr);
      });
      zipfile.on('end', done);
      zipfile.on('entry', (entry) => {
        const name = entry.fileName;
        if (!wanted.some((w) => name === w || (w.endsWith('/') && name.startsWith(w)))) {
          zipfile.readEntry();
          return;
        }
        if (entry.uncompressedSize > limit) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            zipfile.readEntry();
            return;
          }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            found[name] = Buffer.concat(chunks).toString('utf8');
            zipfile.readEntry();
          });
          stream.on('error', () => zipfile.readEntry());
        });
      });
      zipfile.readEntry();
    });
  });
}

/**
 * Does a Maven-style version range contain the given version?
 * Supports `*`, exact versions and ranges like [1.21,1.22), [21.1.0,), (1.20.1,].
 */
export function versionRangeContains(range, version) {
  if (!range) return { matches: true, unknown: true };
  const spec = String(range).trim();
  if (spec === '*' || spec === '' || spec.toLowerCase() === 'any') return { matches: true, unknown: false };
  const bounds = /^([[(])\s*([^,\])]*)\s*(?:,\s*([^)\]]*)\s*)?([)\]])$/.exec(spec);
  if (!bounds) {
    // plain version (e.g. "1.21.1") or a weird string -> compare equality, but do not block
    const match = parseVersion(spec) ? compareVersions(version, spec) === 0 : null;
    return { matches: match === null ? true : match, unknown: match === null, parsed: spec };
  }
  const [, lowerBracket, lower, upper, upperBracket] = bounds;
  const cmp = (a, b) => compareVersions(a, b);
  if (lower) {
    const c = cmp(version, lower);
    if (lowerBracket === '[' ? c < 0 : c <= 0) return { matches: false, parsed: spec, reason: `requires >= ${lowerBracket === '[' ? '' : '>'}${lower}` };
  }
  if (upper) {
    const c = cmp(version, upper);
    if (upperBracket === ']' ? c > 0 : c >= 0) return { matches: false, parsed: spec, reason: `requires < ${upperBracket === ']' ? '=' : ''}${upper}` };
  }
  return { matches: true, parsed: spec };
}

export function parseModMetadata({ fileName, entries, mcVersion, neoforgeVersion }) {
  const result = {
    file: fileName,
    loader: 'unknown',
    modIds: [],
    name: null,
    version: null,
    authors: [],
    description: null,
    dependencies: [],
    issues: [],
  };

  const neoforgeToml = entries['META-INF/neoforge.mods.toml'];
  const forgeToml = entries['META-INF/mods.toml'];
  const fabricJson = entries['fabric.mod.json'];
  const manifest = entries['META-INF/MANIFEST.MF'];

  if (neoforgeToml || forgeToml) {
    const raw = neoforgeToml || forgeToml;
    result.loader = neoforgeToml ? 'neoforge' : 'forge';
    try {
      const parsed = parseToml(raw);
      const mods = Array.isArray(parsed.mods) ? parsed.mods : parsed.mods ? [parsed.mods] : [];
      const first = mods[0] || {};
      result.modIds = mods.map((m) => m.modId).filter(Boolean);
      result.name = first.displayName || first.modId || null;
      result.version = first.version ?? null;
      result.authors = typeof first.authors === 'string' ? [first.authors] : Array.isArray(first.authors) ? first.authors : [];
      result.description = first.description ? String(first.description).slice(0, 500) : null;
      const deps = parsed.dependencies || {};
      for (const [owner, list] of Object.entries(deps)) {
        const arr = Array.isArray(list) ? list : [list];
        for (const dep of arr) {
          if (!dep || typeof dep !== 'object') continue;
          result.dependencies.push({
            owner,
            modId: dep.modId,
            mandatory: dep.mandatory !== false,
            versionRange: dep.versionRange || null,
            type: dep.type || null,
          });
        }
      }
      if (!Array.isArray(parsed.mods)) result.issues.push('mods.toml has no [[mods]] entry.');
      if (result.loader === 'forge') {
        result.issues.push('This is a Forge mod (mods.toml): Forge mods do not load on NeoForge 1.21.x.');
      }
      if (parsed.modLoader === 'javafml' && result.loader === 'neoforge' && parsed.loaderVersion) {
        result.loaderVersion = String(parsed.loaderVersion);
      }
    } catch (err) {
      result.issues.push(`Could not parse the mod metadata: ${err.message}`);
    }
  } else if (fabricJson) {
    result.loader = 'fabric';
    try {
      const parsed = JSON.parse(fabricJson);
      result.modIds = parsed.id ? [parsed.id] : [];
      result.name = parsed.name || parsed.id || null;
      result.version = parsed.version ?? null;
      result.authors = Array.isArray(parsed.authors) ? parsed.authors.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean) : [];
      result.description = parsed.description ? String(parsed.description).slice(0, 500) : null;
      result.environment = parsed.environment || null;
      result.dependencies = Object.entries(parsed.depends || {}).map(([modId, range]) => ({
        modId, mandatory: true, versionRange: typeof range === 'string' ? range : null,
      }));
      result.issues.push('This is a Fabric mod: Fabric mods do not load on NeoForge 1.21.x.');
    } catch (err) {
      result.issues.push(`Could not parse fabric.mod.json: ${err.message}`);
    }
  } else if (manifest) {
    result.loader = 'unknown';
    const get = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'mi').exec(manifest)?.[1]?.trim() || null;
    result.name = get('Implementation-Title') || get('Specification-Title') || fileName;
    result.version = get('Implementation-Version') || get('Specification-Version') || null;
    result.authors = [get('Implementation-Vendor')].filter(Boolean);
    result.issues.push('No NeoForge mod metadata found (no META-INF/neoforge.mods.toml): the server may ignore this jar.');
  } else {
    result.issues.push('No mod metadata found in this jar.');
  }

  // ---- compatibility with the configured versions ---------------------
  const mcDep = result.dependencies.find((d) => d.modId === 'minecraft');
  const nfDep = result.dependencies.find((d) => d.modId === 'neoforge' || d.modId === 'forge');
  result.requiresMinecraft = mcDep?.versionRange || null;
  result.requiresNeoForge = nfDep?.versionRange || null;
  if (mcDep && mcVersion) {
    const check = versionRangeContains(mcDep.versionRange, mcVersion);
    if (!check.matches) result.issues.push(`Needs Minecraft ${check.parsed}${check.reason ? ` (${check.reason})` : ''} but the server runs ${mcVersion}.`);
  }
  if (nfDep && neoforgeVersion) {
    const check = versionRangeContains(nfDep.versionRange, neoforgeVersion);
    if (!check.matches) result.issues.push(`Needs NeoForge ${check.parsed}${check.reason ? ` (${check.reason})` : ''} but the server runs ${neoforgeVersion}.`);
  }
  return result;
}

export class ModsService {
  constructor({ config, logs, minecraft, events }) {
    this.config = config;
    this.log = logs.application.child('mods');
    this.minecraft = minecraft;
    this.events = events;
    this.modsDir = path.join(config.paths.serverDir, 'mods');
    this.sandbox = new PathSandbox(config.paths.serverDir);
    this.cache = new Map(); // file -> {mtimeMs, size, metadata}
    this.index = new JsonStore(path.join(this.modsDir, '.panel-index.json'), { files: {} });
    this.pendingRestart = false;
  }

  async start() {
    await ensureDir(this.modsDir);
    await this.index.load();
  }

  async stop() {
    await this.index.flush().catch(() => {});
  }

  /** List every jar (active or disabled) with its metadata and state. */
  async list({ refresh = false } = {}) {
    await ensureDir(this.modsDir);
    const entries = await fsp.readdir(this.modsDir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const mcVersion = this.config.values.minecraft.version;
    const neoforgeVersion = this.config.values.minecraft.neoforge_version;
    const mods = [];
    const seenIds = new Map();

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.jar(\.disabled)?$/i.test(entry.name)) continue;
      const file = path.join(this.modsDir, entry.name);
      const stat = await statOrNull(file);
      if (!stat) continue;
      const disabled = entry.name.endsWith('.disabled');
      const cacheKey = `${file}:${stat.mtimeMs}:${stat.size}`;
      let metadata = !refresh ? this.cache.get(file) : null;
      if (!metadata || metadata.cacheKey !== cacheKey) {
        let parsed;
        try {
          const entriesFound = await readZipEntries(file, [
            'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'fabric.mod.json', 'META-INF/MANIFEST.MF',
          ]);
          parsed = parseModMetadata({ fileName: entry.name, entries: entriesFound, mcVersion, neoforgeVersion });
          parsed.corrupt = false;
        } catch (err) {
          parsed = {
            file: entry.name, loader: 'unknown', modIds: [], name: entry.name, version: null, authors: [],
            description: null, dependencies: [], issues: [err.message], corrupt: true,
          };
        }
        metadata = { cacheKey, ...parsed };
        this.cache.set(file, metadata);
      }
      const record = { ...metadata };
      const id = record.modIds[0] || record.file;
      const previous = seenIds.get(id);
      const issues = [...(record.issues || [])];
      if (previous && !disabled && !previous.disabled) {
        issues.push(`Duplicate mod id "${id}" (also provided by ${previous.file}). The server will refuse to start.`);
      } else if (!disabled) {
        seenIds.set(id, { file: record.file, disabled });
      }
      let state = 'ok';
      if (disabled) state = 'disabled';
      else if (record.corrupt) state = 'corrupt';
      else if (issues.some((i) => /Fabric mod|Forge mod/.test(i))) state = 'wrong_loader';
      else if (issues.some((i) => /Needs Minecraft|Needs NeoForge|Duplicate/.test(i))) state = 'incompatible';
      else if (issues.length) state = 'warning';

      const hash = this.index.get('files')[record.file]?.sha256 || null;
      mods.push({
        ...record,
        size: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        disabled,
        state,
        issues,
        sha256: hash,
        path: `mods/${record.file}`,
      });
    }

    mods.sort((a, b) => String(a.name || a.file).localeCompare(String(b.name || b.file)));
    return {
      dir: this.modsDir,
      pendingRestart: this.pendingRestart || this.minecraft?.pendingRestart === true,
      serverOnline: this.minecraft?.state === 'online',
      counts: {
        total: mods.length,
        enabled: mods.filter((m) => !m.disabled).length,
        disabled: mods.filter((m) => m.disabled).length,
        problems: mods.filter((m) => ['incompatible', 'corrupt', 'wrong_loader'].includes(m.state)).length,
        warnings: mods.filter((m) => m.state === 'warning').length,
      },
      expected: { minecraft: mcVersion, neoforge: neoforgeVersion },
      mods,
    };
  }

  /** Persist the sha256 of a jar so the UI can detect later tampering. */
  async recordHash(name, sha256) {
    const files = this.index.get('files') || {};
    files[name] = { sha256, at: new Date().toISOString() };
    this.index.set('files', files);
    await this.index.flush();
  }

  markPendingRestart(reason) {
    this.pendingRestart = true;
    if (this.minecraft) this.minecraft.pendingRestart = true;
    this.events?.publish('status', { state: this.minecraft?.state, pendingRestart: true, message: reason });
    this.log.info(`${reason} (server restart needed).`);
  }

  clearPendingRestart() {
    this.pendingRestart = false;
    if (this.minecraft) this.minecraft.pendingRestart = false;
  }

  async hashFile(file) {
    const hash = crypto.createHash('sha256');
    const handle = await fsp.open(file, 'r');
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) hash.update(chunk);
    } finally {
      await handle.close();
    }
    return hash.digest('hex');
  }

  /** Check that an uploaded buffer really is a jar/zip before storing it. */
  async validateJarBuffer(buffer, fileName) {
    if (!/\.jar$/i.test(fileName)) throw new ValidationError(`"${fileName}" must be a .jar file.`);
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw new ValidationError(`"${fileName}" is not a valid jar (zip) file.`, { hint: 'Upload the file exactly as downloaded from Modrinth/CurseForge.' });
    }
    return true;
  }

  async writeMod(fileName, buffer, { replace = false, disableOld = true } = {}) {
    await ensureDir(this.modsDir);
    const safe = path.basename(fileName);
    await this.validateJarBuffer(buffer, safe);
    const target = path.join(this.modsDir, safe);
    const existing = await statOrNull(target);
    if (existing && !replace) {
      throw new AppError(`${safe} already exists in the mods folder.`, {
        code: 'MOD_EXISTS', status: 409, hint: 'Enable "replace" to overwrite it (the previous file is kept in mods/.panel-trash).',
      });
    }
    let backupPath = null;
    if (existing) {
      const trash = path.join(this.modsDir, '.panel-trash');
      await ensureDir(trash);
      backupPath = path.join(trash, `${Date.now()}-${safe}`);
      await fsp.rename(target, backupPath);
    }
    await fsp.writeFile(target, buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    await this.recordHash(safe, sha256);

    // Duplicate mod id detection right after the upload (before a restart).
    const listing = await this.list({ refresh: true });
    const uploaded = listing.mods.find((m) => m.file === safe);
    const conflicts = listing.mods.filter((m) => m.file !== safe && !m.disabled && uploaded && m.modIds[0] && m.modIds[0] === uploaded.modIds[0]);
    this.cache.delete(target);

    if (this.minecraft?.state === 'online') this.markPendingRestart(`${safe} was uploaded; restart the server to load it.`);

    return {
      file: safe,
      size: buffer.length,
      sha256,
      metadata: uploaded || null,
      replaced: existing ? { previousFile: backupPath, disabled: disableOld } : null,
      restartRequired: this.minecraft?.state === 'online',
      conflicts: conflicts.map((c) => ({ file: c.file, modId: c.modIds[0] })),
      restartHint: conflicts.length ? `Another enabled mod (${conflicts.map((c) => c.file).join(', ')}) provides the same mod id: disable one of them.` : null,
    };
  }

  async setEnabled(fileName, enabled) {
    let safe = path.basename(fileName);
    let stat = await statOrNull(path.join(this.modsDir, safe));
    if (!stat) {
      // Tolerate a stale name: a page that was rendered before the last
      // enable/disable still holds the previous file name.
      const alternative = safe.endsWith('.disabled') ? safe.replace(/\.disabled$/, '') : `${safe}.disabled`;
      const alternativeStat = await statOrNull(path.join(this.modsDir, alternative));
      if (alternativeStat) {
        safe = alternative;
        stat = alternativeStat;
      }
    }
    if (!stat) throw new AppError(`Mod not found: ${safe}`, { code: 'NOT_FOUND', status: 404 });
    const current = path.join(this.modsDir, safe);
    const isDisabled = safe.endsWith('.disabled');
    if (enabled && !isDisabled) return { file: safe, changed: false };
    if (!enabled && isDisabled) return { file: safe, changed: false };
    const targetName = enabled ? safe.replace(/\.disabled$/, '') : `${safe}.disabled`;
    const target = path.join(this.modsDir, targetName);
    if (await statOrNull(target)) {
      throw new AppError(`Cannot rename to ${targetName}: the file already exists.`, { code: 'ALREADY_EXISTS', status: 409 });
    }
    await fsp.rename(current, target);
    this.cache.delete(current);
    if (this.minecraft?.state === 'online') this.markPendingRestart(`${targetName} was ${enabled ? 'enabled' : 'disabled'}; restart the server to apply.`);
    return { file: targetName, changed: true, restartRequired: this.minecraft?.state === 'online' };
  }

  async remove(fileName, { confirm = false } = {}) {
    const safe = path.basename(fileName);
    if (!confirm) {
      throw new AppError(`Deleting ${safe} requires confirmation.`, { code: 'CONFIRMATION_REQUIRED', status: 428 });
    }
    const file = path.join(this.modsDir, safe);
    const stat = await statOrNull(file);
    if (!stat) throw new AppError(`Mod not found: ${safe}`, { code: 'NOT_FOUND', status: 404 });
    const trash = path.join(this.modsDir, '.panel-trash');
    await ensureDir(trash);
    const backupPath = path.join(trash, `${Date.now()}-${safe}`);
    await fsp.rename(file, backupPath);
    this.cache.delete(file);
    const files = this.index.get('files') || {};
    delete files[safe];
    this.index.set('files', files);
    await this.index.flush();
    if (this.minecraft?.state === 'online') this.markPendingRestart(`${safe} was removed; restart the server to unload it.`);
    return { file: safe, movedTo: path.relative(this.config.paths.serverDir, backupPath), restartRequired: this.minecraft?.state === 'online' };
  }

  /** Number of jars and total size, used by the dashboard. */
  async summary() {
    const listing = await this.list();
    const bytes = listing.mods.reduce((sum, m) => sum + (m.size || 0), 0);
    return { ...listing.counts, bytes };
  }

  async inspectText(fileName) {
    const safe = path.basename(fileName);
    const file = path.join(this.modsDir, safe);
    const entries = await readZipEntries(file, [
      'META-INF/neoforge.mods.toml', 'META-INF/mods.toml', 'fabric.mod.json', 'META-INF/MANIFEST.MF', 'pack.mcmeta',
    ]);
    return entries;
  }

  /** Leftover ".panel-trash" contents (replace/delete history), for the UI. */
  async trash() {
    const dir = path.join(this.modsDir, '.panel-trash');
    try {
      const files = await walk(dir);
      const out = [];
      for (const rel of files) {
        const stat = await statOrNull(path.join(dir, rel));
        out.push({ file: rel, size: stat?.size ?? null, at: stat ? new Date(stat.mtimeMs).toISOString() : null });
      }
      return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch {
      return [];
    }
  }
}
