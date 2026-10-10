/**
 * FilesService - sandboxed file manager for the Minecraft server directory.
 *
 * Every path is resolved through PathSandbox: `../`, absolute paths, NUL bytes
 * and symlinks pointing outside the root are rejected. Deletions always
 * require an explicit confirmation flag, and installation-critical paths
 * (libraries/, run scripts, the jvm args file) are protected.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PathSandbox } from '../util/paths.js';
import { AppError, ValidationError, fsError } from '../util/errors.js';
import { ensureDir, safeFileName, statOrNull, humanBytes } from '../util/fsx.js';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.properties', '.json', '.json5', '.toml', '.yml', '.yaml', '.cfg', '.conf', '.ini', '.log', '.md',
  '.sh', '.bat', '.ps1', '.cmd', '.csv', '.xml', '.html', '.js', '.ts', '.java', '.mcmeta', '.snbt', '.lang',
]);

const PREVIEW_EXTENSIONS = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
]);

const PROTECTED_PREFIXES = ['libraries', 'run.sh', 'run.bat', 'user_jvm_args.txt', 'mods/.panel-index.json'];

export class FilesService {
  constructor({ config, logs }) {
    this.config = config;
    this.log = logs.application.child('files');
    this.sandbox = new PathSandbox(config.fileRoot);
    this.maxUploadBytes = config.maxUploadBytes;
    this.maxEditBytes = config.maxEditBytes;
  }

  get root() {
    return this.sandbox.root;
  }

  describe() {
    return {
      root: this.sandbox.root,
      relativeRoot: path.relative(this.config.paths.projectRoot, this.sandbox.root) || '.',
      maxUploadBytes: this.maxUploadBytes,
      maxUploadHuman: humanBytes(this.maxUploadBytes),
      maxEditBytes: this.maxEditBytes,
      protectedPaths: PROTECTED_PREFIXES,
    };
  }

  resolve(relative, options) {
    return this.sandbox.resolve(relative, options);
  }

  isTextFile(name, { size = 0 } = {}) {
    const ext = path.extname(name).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (!ext && size < 1024 * 1024) return true; // e.g. eula.txt
    return false;
  }

  previewMime(name) {
    return PREVIEW_EXTENSIONS.get(path.extname(name).toLowerCase()) || null;
  }

  isProtected(relative) {
    const rel = relative.replace(/\\/g, '/');
    return PROTECTED_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`) || rel === p.replace(/\/$/, ''));
  }

  /** Directory listing with metadata needed by the UI. */
  async list(relative = '') {
    const rel = this.sandbox.normalize(relative);
    const abs = await this.sandbox.resolveExisting(rel).catch((err) => {
      throw err;
    });
    const stat = await statOrNull(abs);
    if (!stat) throw new AppError(`Directory not found: ${rel || '/'}`, { code: 'NOT_FOUND', status: 404 });
    if (!stat.isDirectory()) throw new AppError(`${rel} is a file, not a directory.`, { code: 'NOT_A_DIRECTORY', status: 400 });

    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      throw fsError(err, rel || '/', 'list');
    }

    const entries = [];
    for (const dirent of dirents) {
      const entryRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const entryAbs = path.join(abs, dirent.name);
      const entryStat = await statOrNull(entryAbs);
      // lstat: never follow a symlink out of the sandbox
      const lstat = await fsp.lstat(entryAbs).catch(() => null);
      const isSymlink = lstat?.isSymbolicLink() || false;
      if (isSymlink) {
        const target = await fsp.realpath(entryAbs).catch(() => null);
        if (!target || !this.sandbox.contains(target)) continue; // hide escaping links
      }
      entries.push({
        name: dirent.name,
        path: entryRel,
        type: dirent.isDirectory() ? 'directory' : 'file',
        size: dirent.isDirectory() ? null : entryStat?.size ?? null,
        sizeHuman: dirent.isDirectory() ? null : humanBytes(entryStat?.size),
        modifiedAt: entryStat ? new Date(entryStat.mtimeMs).toISOString() : null,
        editable: dirent.isFile() && this.isTextFile(dirent.name, { size: entryStat?.size ?? 0 }) && (entryStat?.size ?? 0) <= this.maxEditBytes,
        preview: dirent.isFile() ? this.previewMime(dirent.name) : null,
        protected: this.isProtected(entryRel),
        symlink: isSymlink,
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return {
      path: rel,
      absolute: abs,
      parent: rel ? parentRel : null,
      readonly: false,
      entries,
      breadcrumbs: rel ? rel.split('/').map((part, index, all) => ({ name: part, path: all.slice(0, index + 1).join('/') })) : [],
    };
  }

  async readFile(relative) {
    const rel = this.sandbox.normalize(relative, { allowEmpty: false });
    const abs = await this.sandbox.resolveExisting(rel);
    const stat = await statOrNull(abs);
    if (!stat || !stat.isFile()) throw new AppError(`File not found: ${rel}`, { code: 'NOT_FOUND', status: 404 });
    if (stat.size > this.maxEditBytes && this.isTextFile(rel, { size: stat.size })) {
      throw new AppError(`${rel} is too large to edit (${humanBytes(stat.size)}, limit ${humanBytes(this.maxEditBytes)}).`, {
        code: 'FILE_TOO_LARGE', status: 413, hint: 'Download it instead, edit it locally and upload it back.',
      });
    }
    const buffer = await fsp.readFile(abs);
    const isBinary = buffer.includes(0);
    if (isBinary) {
      const mime = this.previewMime(rel);
      return {
        path: rel, size: stat.size, binary: true, mime,
        base64: mime ? buffer.toString('base64') : null,
        content: null, modifiedAt: new Date(stat.mtimeMs).toISOString(),
      };
    }
    return {
      path: rel,
      size: stat.size,
      binary: false,
      content: stripBom(buffer.toString('utf8')),
      encoding: 'utf8',
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      lines: buffer.toString('utf8').split('\n').length,
    };
  }

  async writeFile(relative, content, { expectedModifiedAt = null } = {}) {
    if (typeof content !== 'string') throw new ValidationError('The file content must be a string.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxEditBytes) {
      throw new AppError(`The content is too large (${humanBytes(bytes)}, limit ${humanBytes(this.maxEditBytes)}).`, { code: 'FILE_TOO_LARGE', status: 413 });
    }
    const rel = this.sandbox.normalize(relative, { allowEmpty: false });
    const abs = await this.sandbox.resolveExisting(rel);
    const stat = await statOrNull(abs);
    if (stat && expectedModifiedAt) {
      const current = new Date(stat.mtimeMs).toISOString();
      if (current !== expectedModifiedAt) {
        throw new AppError(`${rel} changed on disk since you opened it.`, {
          code: 'FILE_CHANGED', status: 409, hint: 'Reload the file and apply your changes again to avoid overwriting the newer version.',
        });
      }
    }
    await fsp.writeFile(abs, content, 'utf8');
    const after = await fsp.stat(abs);
    this.log.info(`Wrote ${rel} (${humanBytes(after.size)})`);
    return { path: rel, size: after.size, modifiedAt: new Date(after.mtimeMs).toISOString() };
  }

  /** Stream an upload to disk (never buffered fully in memory). */
  async saveStream(relativeDir, fileName, stream, { maxBytes = this.maxUploadBytes, overwrite = false } = {}) {
    const dir = this.sandbox.normalize(relativeDir);
    const dirAbs = await this.sandbox.resolveExisting(dir);
    const stat = await statOrNull(dirAbs);
    if (stat && !stat.isDirectory()) throw new AppError(`${dir} is not a directory.`, { code: 'NOT_A_DIRECTORY', status: 400 });
    await ensureDir(dirAbs);

    const safe = safeFileName(fileName, { fallback: 'upload.bin' });
    if (!safe || safe === '.' || safe === '..') throw new ValidationError('Invalid file name.');
    if (safe.length > 200) throw new ValidationError('The file name is too long (max 200 characters).');
    const rel = dir ? `${dir}/${safe}` : safe;
    if (this.isProtected(rel)) throw new AppError(`${rel} is protected and cannot be overwritten through the file manager.`, { code: 'PROTECTED_PATH', status: 403 });
    const abs = this.sandbox.resolve(rel);
    if (!overwrite && (await statOrNull(abs))) {
      throw new AppError(`${rel} already exists.`, { code: 'ALREADY_EXISTS', status: 409, hint: 'Enable "overwrite" to replace it.' });
    }

    const tmp = `${abs}.upload-${process.pid}-${Date.now()}.part`;
    let received = 0;
    let aborted = null;
    const counter = new (await import('node:stream')).Transform({
      transform: (chunk, _enc, cb) => {
        received += chunk.length;
        if (received > maxBytes) {
          aborted = new AppError(`The upload exceeds the ${humanBytes(maxBytes)} limit.`, {
            code: 'UPLOAD_TOO_LARGE', status: 413, hint: 'Increase [files].max_upload_mb in the configuration, or upload a smaller file.',
          });
          cb(aborted);
          return;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, counter, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (aborted) throw aborted;
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw aborted || fsError(err, rel, 'write');
    }
    return { path: rel, size: received, sizeHuman: humanBytes(received) };
  }

  async mkdir(relative) {
    const rel = this.sandbox.normalize(relative, { allowEmpty: false });
    const abs = this.sandbox.resolve(rel);
    if (await statOrNull(abs)) throw new AppError(`${rel} already exists.`, { code: 'ALREADY_EXISTS', status: 409 });
    await ensureDir(abs);
    this.log.info(`Created directory ${rel}`);
    return { path: rel, created: true };
  }

  async delete(relative, { confirm = false, recursive = false } = {}) {
    const rel = this.sandbox.normalize(relative, { allowEmpty: false });
    if (!confirm) {
      throw new AppError(`Deleting ${rel} requires confirmation.`, { code: 'CONFIRMATION_REQUIRED', status: 428, hint: 'The UI asks for confirmation before sending this request.' });
    }
    if (this.isProtected(rel)) {
      throw new AppError(`${rel} is required by the server installation and cannot be deleted from the panel.`, {
        code: 'PROTECTED_PATH', status: 403, hint: 'Delete it manually from the filesystem if you really need to.',
      });
    }
    const abs = await this.sandbox.resolveExisting(rel);
    const stat = await statOrNull(abs);
    if (!stat) throw new AppError(`Not found: ${rel}`, { code: 'NOT_FOUND', status: 404 });
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(abs);
      if (entries.length > 0 && !recursive) {
        throw new AppError(`${rel} is not empty (${entries.length} entries).`, {
          code: 'DIRECTORY_NOT_EMPTY', status: 409, hint: 'Enable the recursive option to delete the folder and its content.',
        });
      }
    }
    const target = await fsp.realpath(abs);
    if (!this.sandbox.contains(target)) throw new AppError('Refusing to delete a path outside the sandbox.', { code: 'PATH_TRAVERSAL', status: 400 });
    await fsp.rm(target, { recursive: stat.isDirectory(), force: false });
    this.log.warn(`Deleted ${rel}${stat.isDirectory() ? ' (recursive)' : ''}`);
    return { path: rel, deleted: true, wasDirectory: stat.isDirectory() };
  }

  async rename(from, to) {
    const relFrom = this.sandbox.normalize(from, { allowEmpty: false });
    const relTo = this.sandbox.normalize(to, { allowEmpty: false });
    if (this.isProtected(relFrom) || this.isProtected(relTo)) {
      throw new AppError('Protected paths cannot be renamed from the panel.', { code: 'PROTECTED_PATH', status: 403 });
    }
    const absFrom = await this.sandbox.resolveExisting(relFrom);
    const absTo = this.sandbox.resolve(relTo);
    if (await statOrNull(absTo)) throw new AppError(`${relTo} already exists.`, { code: 'ALREADY_EXISTS', status: 409 });
    await ensureDir(path.dirname(absTo));
    await fsp.rename(absFrom, absTo);
    return { from: relFrom, to: relTo };
  }

  /** Open a read stream for downloads (path already validated). */
  async openDownload(relative) {
    const rel = this.sandbox.normalize(relative, { allowEmpty: false });
    const abs = await this.sandbox.resolveExisting(rel);
    const stat = await statOrNull(abs);
    if (!stat || !stat.isFile()) throw new AppError(`File not found: ${rel}`, { code: 'NOT_FOUND', status: 404 });
    return { stream: fs.createReadStream(abs), size: stat.size, name: safeFileName(rel), path: rel };
  }

  /** Free space of the volume holding the server directory. */
  async diskUsage() {
    try {
      const stats = await fsp.statfs(this.root);
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      return { totalBytes: total, freeBytes: free, usedBytes: total - free, freeHuman: humanBytes(free), totalHuman: humanBytes(total) };
    } catch (err) {
      return { error: `Could not read disk usage: ${err.message}` };
    }
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
