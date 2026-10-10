/**
 * Static file serving for the two single-page interfaces.
 * Paths are resolved inside a fixed root (sandboxed), with a small MIME map and
 * cache headers that keep development painless.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PathSandbox } from '../util/paths.js';
import { statOrNull } from '../util/fsx.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export class StaticServer {
  /**
   * @param {object} options
   * @param {string} options.root directory that is served
   * @param {string} options.index  index file (default index.html)
   * @param {boolean} options.spaFallback serve index.html for unknown paths (hash/SPA routing)
   */
  constructor({ root, index = 'index.html', spaFallback = true, headers = {} }) {
    this.root = root;
    this.index = index;
    this.spaFallback = spaFallback;
    this.headers = headers;
    this.sandbox = new PathSandbox(root);
  }

  async handle(req, res, { pathname } = {}) {
    const urlPath = pathname ?? new URL(req.url, 'http://localhost').pathname;
    let relative = urlPath.replace(/^\/+/, '');
    if (relative === '' || relative.endsWith('/')) relative += this.index;
    let target;
    try {
      target = this.sandbox.resolve(decodeURIComponent(relative));
    } catch {
      return false;
    }
    let stat = await statOrNull(target);
    if (stat?.isDirectory()) {
      target = path.join(target, this.index);
      stat = await statOrNull(target);
    }
    if (!stat?.isFile()) {
      if (!this.spaFallback) return false;
      target = path.join(this.root, this.index);
      stat = await statOrNull(target);
      if (!stat?.isFile()) return false;
      // Only fall back for browser navigations, never for asset requests.
      if (path.extname(relative) && path.extname(relative) !== '.html') return false;
    }
    const stream = fs.createReadStream(target);
    const out = new PassThrough();
    stream.pipe(out);
    res.writeHead(200, {
      'content-type': mimeFor(target),
      'content-length': stat.size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      ...this.headers,
    });
    stream.on('error', () => res.end());
    out.pipe(res);
    return true;
  }
}

export async function listFiles(dir, prefix = '') {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}
