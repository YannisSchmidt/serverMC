/** Small filesystem helpers used across services. */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fsError } from './errors.js';

export async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw fsError(err, dir, 'create directory');
  }
  return dir;
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

/** Atomic write: write to a temp file in the same directory then rename. */
export async function writeFileAtomic(target, data, options = {}) {
  const dir = path.dirname(target);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, data, options);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw fsError(err, target, 'write');
  }
}

export async function readJson(target, fallback = null) {
  try {
    const raw = await fsp.readFile(target, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${target}: ${err.message}`);
    }
    throw fsError(err, target, 'read');
  }
}

export async function writeJson(target, value, { mode } = {}) {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : {});
}

export function readJsonSync(target, fallback = null) {
  try {
    const raw = fs.readFileSync(target, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    return fallback;
  }
}

/** Recursively list files (relative paths) below `dir`, skipping ignored names. */
export async function walk(dir, { ignore = new Set(), maxEntries = 200000 } = {}) {
  const out = [];
  async function visit(current, rel) {
    if (out.length > maxEntries) return;
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw fsError(err, current, 'list');
    }
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(abs, relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  }
  await visit(dir, '');
  return out;
}

export async function dirSize(dir, options = {}) {
  const files = await walk(dir, options);
  let bytes = 0;
  for (const rel of files) {
    const st = await statOrNull(path.join(dir, rel));
    if (st) bytes += st.size;
  }
  return { bytes, files: files.length };
}

export async function copyRecursive(src, dest) {
  await ensureDir(dest);
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyRecursive(from, to);
    else if (entry.isSymbolicLink()) continue; // never follow symlinks out of the sandbox
    else await pipeline(fs.createReadStream(from), fs.createWriteStream(to));
  }
}

export async function sha1File(target) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(target), hash);
  return hash.digest('hex');
}

export async function sha256File(target) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(target), hash);
  return hash.digest('hex');
}

export function humanBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Turn an arbitrary string into a safe file name (no traversal, no separators). */
export function safeFileName(name, { fallback = 'file' } = {}) {
  const base = String(name ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return base || fallback;
}

export function timestampSlug(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}
