/**
 * BackupService - zip archives of the server data.
 *
 * Naming: backup_YYYY-MM-DD_HH-mm-ss[_label].zip (project spec).
 * Restores are always preceded by a safety backup and require the server to be
 * stopped; extraction refuses any entry that tries to escape the server
 * directory (zip-slip protection) and skips volatile files such as
 * session.lock.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { AppError } from '../util/errors.js';
import { ensureDir, humanBytes, statOrNull, timestampSlug, safeFileName, dirSize, pathExists } from '../util/fsx.js';
import { PathSandbox } from '../util/paths.js';
import { redactString } from '../util/redact.js';

const SKIP_NAMES = new Set(['session.lock', '.panel-index.json', '.panel-trash']);
const SKIP_SUFFIXES = ['.lock', '.part', '.tmp', '.upload'];
const SKIP_DIRS = new Set(['logs', 'crash-reports']);

export function isSkippedEntry(relPath) {
  const parts = relPath.split('/');
  if (parts.some((p) => SKIP_NAMES.has(p) || SKIP_DIRS.has(p))) return true;
  if (SKIP_SUFFIXES.some((s) => relPath.endsWith(s))) return true;
  return false;
}

export class BackupService {
  constructor({ config, logs, minecraft, events }) {
    this.config = config;
    this.log = logs.application.child('backup');
    this.minecraft = minecraft;
    this.events = events;
    this.timer = null;
    this.running = null; // { name, progress } while a backup is being written
    this.sandbox = new PathSandbox(config.paths.backupsDir);
    this.serverSandbox = new PathSandbox(config.paths.serverDir);
  }

  async start() {
    await ensureDir(this.config.paths.backupsDir);
    this.scheduleAutoBackup();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scheduleAutoBackup() {
    const hours = Number(this.config.values.backups.auto_backup_interval_h || 0);
    if (!hours) return;
    const intervalMs = Math.min(hours, 24) * 3600 * 1000;
    this.timer = setInterval(async () => {
      try {
        await this.create({ label: 'auto', reason: 'scheduled automatic backup' });
      } catch (err) {
        this.log.error(`Automatic backup failed: ${err.message}`);
      }
    }, intervalMs);
    this.log.info(`Automatic backups enabled every ${hours} hour(s).`);
  }

  /** Canonical archive name required by the project specification. */
  backupName() {
    return `backup_${timestampSlug()}.zip`;
  }

  /** Same-second backups get a -2, -3, ... suffix instead of overwriting. */
  async uniqueBackupName() {
    const base = this.backupName();
    let candidate = base;
    let counter = 2;
    while (await pathExists(path.join(this.config.paths.backupsDir, candidate))) {
      candidate = base.replace(/\.zip$/, `-${counter}.zip`);
      counter += 1;
      if (counter > 50) throw new AppError('Could not find a free backup file name.', { code: 'BACKUP_FAILED', status: 500 });
    }
    return candidate;
  }

  async list() {
    await ensureDir(this.config.paths.backupsDir);
    const dirents = await fsp.readdir(this.config.paths.backupsDir, { withFileTypes: true });
    const backups = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirnameSafe(dirent.name)) continue;
      if (!/\.zip$/i.test(dirent.name)) continue;
      const stat = await statOrNull(path.join(this.config.paths.backupsDir, dirent.name));
      let meta = null;
      const metaFile = path.join(this.config.paths.backupsDir, `${dirent.name}.json`);
      try {
        meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
      } catch {
        meta = null;
      }
      backups.push({
        name: dirent.name,
        size: stat?.size ?? null,
        sizeHuman: humanBytes(stat?.size),
        createdAt: stat ? new Date(stat.mtimeMs).toISOString() : null,
        label: meta?.label || null,
        reason: meta?.reason || null,
        includes: meta?.includes || null,
        serverState: meta?.serverState || null,
        minecraft: meta?.minecraft || null,
      });
    }
    backups.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { dir: this.config.paths.backupsDir, count: backups.length, backups };
  }

  /**
   * Create a zip archive of the configured paths.
   * The world is always included; mods only when [backups].include_mods is on.
   */
  async create({ label = '', reason = 'manual backup', includeMods = null, onProgress = null, source = null } = {}) {
    if (this.running) {
      throw new AppError(`A backup is already running (${this.running.name}).`, { code: 'BACKUP_IN_PROGRESS', status: 409 });
    }
    await ensureDir(this.config.paths.backupsDir);
    const includes = source ? [source] : [...(this.config.values.backups.include || [])];
    if (includeMods === null ? this.config.values.backups.include_mods : includeMods) includes.push('mods');

    const name = await this.uniqueBackupName();
    const target = path.join(this.config.paths.backupsDir, name);
    const serverDir = this.config.paths.serverDir;
    this.running = { name, startedAt: Date.now(), progress: 0 };
    this.events?.publish('job', { job: 'backup', state: 'running', name, reason });

    const files = [];
    for (const rel of includes) {
      const abs = path.resolve(serverDir, rel);
      if (!this.serverSandbox.contains(abs)) {
        throw new AppError(`[backups].include contains a path outside the server directory: ${rel}`, { code: 'INVALID_CONFIGURATION', status: 400 });
      }
      const stat = await statOrNull(abs);
      if (!stat) {
        this.log.warn(`Backup: skipping missing path ${rel}`);
        continue;
      }
      if (stat.isDirectory()) {
        const relFiles = await walkForBackup(abs, rel);
        files.push(...relFiles);
      } else {
        files.push({ abs, rel });
      }
    }
    if (files.length === 0) {
      this.running = null;
      throw new AppError('Nothing to back up: the configured paths do not exist yet.', {
        code: 'NOTHING_TO_BACKUP', status: 409, hint: 'Start the server once so it creates the world folder, then try again.',
      });
    }
    const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

    try {
      await new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        const out = fs.createWriteStream(target);
        out.on('error', reject);
        out.on('close', resolve);
        zip.outputStream.pipe(out);
        let added = 0;
        for (const file of files) {
          zip.addFile(file.abs, file.rel, { compress: !/\.jar$/i.test(file.rel) });
          added += 1;
          if (added % 200 === 0) {
            const progress = Math.round((added / files.length) * 100);
            this.running.progress = progress;
            onProgress?.({ processed: added, total: files.length, percent: progress });
            this.events?.publish('job', { job: 'backup', state: 'running', name, percent: progress, processed: added, total: files.length });
          }
        }
        zip.end();
      });

      const stat = await fsp.stat(target);
      const meta = {
        name,
        label: label || null,
        reason,
        createdAt: new Date().toISOString(),
        includes,
        files: files.length,
        totalSourceBytes: totalBytes,
        minecraft: {
          version: this.config.values.minecraft.version,
          neoforge: this.config.values.minecraft.neoforge_version,
        },
        serverState: this.minecraft?.state || 'unknown',
      };
      await fsp.writeFile(`${target}.json`, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      this.log.info(`Backup created: ${name} (${files.length} files, ${humanBytes(stat.size)})`);
      this.events?.publish('job', { job: 'backup', state: 'done', name, size: stat.size, files: files.length });
      await this.prune();
      return {
        ...meta,
        size: stat.size,
        sizeHuman: humanBytes(stat.size),
        durationMs: Date.now() - this.running.startedAt,
        path: target,
      };
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => {});
      this.events?.publish('job', { job: 'backup', state: 'error', name, message: redactString(err.message) });
      if (err instanceof AppError) throw err;
      throw new AppError(`Backup failed: ${err.message}`, {
        code: 'BACKUP_FAILED', status: 500,
        hint: 'Check the free disk space and that the server directory is readable, then retry.',
      });
    } finally {
      this.running = null;
    }
  }

  async prune() {
    const keep = Number(this.config.values.backups.keep_last || 0);
    if (!keep) return { pruned: [] };
    const { backups } = await this.list();
    const toDelete = backups.slice(keep);
    for (const backup of toDelete) {
      await fsp.rm(path.join(this.config.paths.backupsDir, backup.name), { force: true });
      await fsp.rm(path.join(this.config.paths.backupsDir, `${backup.name}.json`), { force: true });
      this.log.info(`Pruned old backup ${backup.name} (keep_last=${keep}).`);
    }
    return { pruned: toDelete.map((b) => b.name) };
  }

  /** Validate an archive before touching the server (used by restore and doctor). */
  async inspect(name) {
    const file = this.sandbox.resolve(name, { allowEmpty: false });
    const stat = await statOrNull(file);
    if (!stat) throw new AppError(`Backup not found: ${name}`, { code: 'NOT_FOUND', status: 404 });
    return new Promise((resolve, reject) => {
      yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
        if (err) {
          reject(new AppError(`${name} is not a readable zip archive: ${err.message}`, { code: 'INVALID_BACKUP', status: 400 }));
          return;
        }
        const entries = [];
        let totalBytes = 0;
        let problems = 0;
        zipfile.on('error', (zipErr) => reject(new AppError(`Could not read ${name}: ${zipErr.message}`, { code: 'INVALID_BACKUP', status: 400 })));
        zipfile.on('entry', (entry) => {
          entries.push({ name: entry.fileName, size: entry.uncompressedSize, dir: entry.fileName.endsWith('/') });
          totalBytes += entry.uncompressedSize;
          if (!isSafeEntryName(entry.fileName)) problems += 1;
          zipfile.readEntry();
        });
        zipfile.on('end', () => {
          const topLevel = [...new Set(entries.map((e) => e.name.split('/')[0]))].filter(Boolean);
          resolve({
            name,
            size: stat.size,
            sizeHuman: humanBytes(stat.size),
            entries: entries.length,
            totalBytes,
            totalHuman: humanBytes(totalBytes),
            topLevel,
            createdAt: new Date(stat.mtimeMs).toISOString(),
            safe: problems === 0,
            problems,
            hasWorld: topLevel.includes('world'),
            hasProperties: entries.some((e) => e.name === 'server.properties'),
          });
        });
        zipfile.readEntry();
      });
    });
  }

  /**
   * Restore a backup.
   *   1. refuse while the server is running (unless stopServer is true)
   *   2. create a safety backup of the current state
   *   3. extract with zip-slip protection
   *   4. optionally restart the server
   */
  async restore(name, { confirm = false, stopServer = true, restartAfter = false, onProgress = null } = {}) {
    if (!confirm) {
      throw new AppError('Restoring a backup requires confirmation.', {
        code: 'CONFIRMATION_REQUIRED', status: 428,
        hint: 'Restoring overwrites the current world. The panel offers to create a safety backup first.',
      });
    }
    const file = this.sandbox.resolve(name, { allowEmpty: false });
    const inspection = await this.inspect(name);
    if (!inspection.safe) {
      throw new AppError(`${name} contains unsafe entries and was refused.`, {
        code: 'UNSAFE_BACKUP', status: 400,
        hint: 'The archive contains absolute paths or ".." entries. Extract it manually only if you trust its source.',
      });
    }
    let wasRunning = false;
    if (this.minecraft?.isRunning()) {
      if (!stopServer) {
        throw new AppError('The server is running: stop it before restoring a backup.', { code: 'SERVER_RUNNING', status: 409, hint: 'Use "Stop then restore" or stop the server manually first.' });
      }
      wasRunning = true;
      this.events?.publish('job', { job: 'restore', state: 'stopping', name });
      const result = await this.minecraft.requestStop({ reason: `restore ${name}`, force: true });
      if (!result.stopped) {
        throw new AppError('The server could not be stopped, restore aborted.', { code: 'STOP_TIMEOUT', status: 409, hint: result.hint });
      }
    }

    let safetyBackup = null;
    if (this.config.values.backups.safety_backup_before_restore !== false) {
      this.events?.publish('job', { job: 'restore', state: 'safety-backup', name });
      try {
        safetyBackup = await this.create({ label: 'pre-restore', reason: `safety backup before restoring ${name}`, onProgress });
      } catch (err) {
        if (err.code === 'NOTHING_TO_BACKUP') {
          this.log.warn('No existing world to protect with a safety backup (first installation).');
        } else {
          throw new AppError(`Restore aborted: the safety backup failed (${err.message}).`, {
            code: 'SAFETY_BACKUP_FAILED', status: 500,
            hint: 'Nothing was modified. Check the free disk space and retry.',
          });
        }
      }
    }

    this.events?.publish('job', { job: 'restore', state: 'extracting', name });
    const serverDir = this.config.paths.serverDir;
    const restored = { files: 0, bytes: 0, skipped: 0 };
    try {
      await new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
          if (err) {
            reject(new AppError(`Could not open ${name}: ${err.message}`, { code: 'INVALID_BACKUP', status: 400 }));
            return;
          }
          zipfile.on('error', (zipErr) => reject(new AppError(`Restore failed while reading ${name}: ${zipErr.message}`, { code: 'RESTORE_FAILED', status: 500 })));
          zipfile.on('entry', (entry) => {
            const rel = normalizeEntry(entry.fileName);
            if (!rel || !isSafeEntryName(entry.fileName)) {
              restored.skipped += 1;
              this.log.warn(`Restore: skipped unsafe entry "${entry.fileName}"`);
              zipfile.readEntry();
              return;
            }
            const target = path.join(serverDir, rel);
            if (!this.serverSandbox.contains(target)) {
              restored.skipped += 1;
              zipfile.readEntry();
              return;
            }
            if (entry.fileName.endsWith('/')) {
              fsp.mkdir(target, { recursive: true }).then(() => zipfile.readEntry(), reject);
              return;
            }
            fsp.mkdir(path.dirname(target), { recursive: true })
              .then(() => new Promise((res, rej) => {
                zipfile.openReadStream(entry, (streamErr, readStream) => {
                  if (streamErr) {
                    rej(streamErr);
                    return;
                  }
                  const out = fs.createWriteStream(target);
                  readStream.pipe(out);
                  out.on('close', () => {
                    restored.files += 1;
                    restored.bytes += entry.uncompressedSize;
                    res();
                  });
                  out.on('error', rej);
                });
              }))
              .then(() => {
                if (restored.files % 200 === 0) {
                  onProgress?.({ phase: 'extracting', files: restored.files });
                  this.events?.publish('job', { job: 'restore', state: 'extracting', name, files: restored.files });
                }
                zipfile.readEntry();
              }, reject);
          });
          zipfile.on('end', resolve);
          zipfile.readEntry();
        });
      });
    } catch (err) {
      this.events?.publish('job', { job: 'restore', state: 'error', name, message: redactString(err.message) });
      throw err instanceof AppError ? err : new AppError(`Restore failed: ${err.message}`, { code: 'RESTORE_FAILED', status: 500, hint: 'The safety backup was kept; you can restore it from the Backups page.' });
    }

    // Remove volatile files that must not survive a restore.
    for (const rel of ['world/session.lock', 'world/nether/session.lock', 'world/the_end/session.lock']) {
      await fsp.rm(path.join(serverDir, rel), { force: true }).catch(() => {});
    }

    this.log.info(`Restored ${name}: ${restored.files} files (${humanBytes(restored.bytes)}), ${restored.skipped} unsafe entries skipped.`);
    this.events?.publish('job', { job: 'restore', state: 'done', name, ...restored });

    let restarted = false;
    if (restartAfter && (wasRunning || restartAfter)) {
      try {
        await this.minecraft.startServer({ reason: `restart after restoring ${name}` });
        restarted = true;
      } catch (err) {
        throw new AppError(`The backup was restored but the server could not be restarted: ${err.message}`, {
          code: 'RESTART_FAILED', status: 500, hint: err.hint || 'Start the server manually from the dashboard.',
        });
      }
    }
    return { name, inspection, safetyBackup: safetyBackup?.name || null, restored, restarted, wasRunning };
  }

  async remove(name, { confirm = false } = {}) {
    if (!confirm) throw new AppError(`Deleting ${name} requires confirmation.`, { code: 'CONFIRMATION_REQUIRED', status: 428 });
    const file = this.sandbox.resolve(name, { allowEmpty: false });
    const stat = await statOrNull(file);
    if (!stat) throw new AppError(`Backup not found: ${name}`, { code: 'NOT_FOUND', status: 404 });
    await fsp.rm(file, { force: true });
    await fsp.rm(`${file}.json`, { force: true });
    this.log.warn(`Backup deleted: ${name}`);
    return { name, deleted: true };
  }

  async openDownload(name) {
    const file = this.sandbox.resolve(name, { allowEmpty: false });
    const stat = await statOrNull(file);
    if (!stat) throw new AppError(`Backup not found: ${name}`, { code: 'NOT_FOUND', status: 404 });
    return { stream: fs.createReadStream(file), size: stat.size, name: safeFileName(name) };
  }

  async usage() {
    const { bytes, files } = await dirSize(this.config.paths.backupsDir).catch(() => ({ bytes: 0, files: 0 }));
    return { bytes, files, human: humanBytes(bytes), dir: this.config.paths.backupsDir };
  }
}

/** Reject entries that would escape the extraction root. */
export function isSafeEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  return !parts.includes('..');
}

export function normalizeEntry(name) {
  return String(name).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.').join('/');
}

function dirnameSafe(name) {
  return !name.includes('/') && !name.includes('\\') && !name.includes('..');
}

async function walkForBackup(absDir, relBase) {
  const out = [];
  async function visit(current, rel) {
    let dirents;
    try {
      dirents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const entryRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (isSkippedEntry(entryRel)) continue;
      const abs = path.join(current, dirent.name);
      if (dirent.isDirectory()) await visit(abs, entryRel);
      else if (dirent.isFile()) {
        const stat = await statOrNull(abs);
        if (stat) out.push({ abs, rel: entryRel, size: stat.size });
      }
      // symlinks are never followed during a backup
    }
  }
  await visit(absDir, relBase);
  return out;
}
