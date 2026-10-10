/**
 * Path sandboxing.
 *
 * Security critical: every path coming from the browser (file manager, mods,
 * backups, log viewer) goes through `resolveWithin()`. It guarantees the
 * resolved path is inside the allowed root, even in the presence of
 * `../`, absolute paths, encoded separators, NUL bytes or symlinks pointing
 * outside of the root.
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { AppError } from './errors.js';

const IGNORED_SEGMENTS = new Set(['.', '']);

export class PathSandbox {
  /** @param {string} root absolute directory that the sandbox is limited to */
  constructor(root) {
    if (!root || typeof root !== 'string') throw new AppError('Sandbox root is not configured.', { code: 'INVALID_CONFIGURATION', status: 500 });
    if (!path.isAbsolute(root)) throw new AppError(`Sandbox root must be an absolute path, got "${root}".`, { code: 'INVALID_CONFIGURATION', status: 500 });
    this.root = path.resolve(root);
  }

  /** Normalise a user supplied relative path, rejecting anything suspicious. */
  normalize(input, { allowEmpty = true } = {}) {
    if (input === undefined || input === null) {
      if (allowEmpty) return '';
      throw new AppError('A path is required.', { code: 'VALIDATION_ERROR', status: 400 });
    }
    if (typeof input !== 'string') throw new AppError('Path must be a string.', { code: 'VALIDATION_ERROR', status: 400 });
    if (input.includes('\0')) throw new AppError('Path contains a NUL byte.', { code: 'PATH_TRAVERSAL', status: 400 });
    // Encoded traversal is refused as well: a proxy that decodes twice (or a
    // handler that forgets to decode) must not be able to escape the sandbox.
    if (/%2e%2e|%2f|%5c|%00/i.test(input)) {
      throw new AppError('Path contains encoded traversal characters.', { code: 'PATH_TRAVERSAL', status: 400 });
    }
    // Windows drive / UNC / absolute paths are rejected outright.
    const raw = input.replace(/\\/g, '/').trim();
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) {
      throw new AppError('Absolute paths are not allowed.', { code: 'PATH_TRAVERSAL', status: 400 });
    }
    const segments = [];
    for (const segment of raw.split('/')) {
      // "." and empty segments (repeated or trailing slashes) are harmless.
      if (IGNORED_SEGMENTS.has(segment)) continue;
      // ".." is always refused: it is never needed by the UI and silently
      // rewriting a traversal attempt would hide attacks from the logs.
      if (segment === '..') throw new AppError('Path traversal is not allowed.', { code: 'PATH_TRAVERSAL', status: 400 });
      segments.push(segment);
    }
    const normalized = segments.join('/');
    if (!normalized && !allowEmpty) {
      throw new AppError('An empty path is only valid for the sandbox root.', { code: 'VALIDATION_ERROR', status: 400 });
    }
    return normalized;
  }

  /** Resolve a relative path to an absolute one, guaranteeing containment. */
  resolve(input, options) {
    const rel = this.normalize(input, options);
    const abs = path.resolve(this.root, rel);
    if (!this.contains(abs)) {
      throw new AppError('The requested path is outside of the sandbox.', { code: 'PATH_TRAVERSAL', status: 400 });
    }
    return abs;
  }

  /** Convert an absolute path back to a sandbox relative one. */
  relative(abs) {
    const rel = path.relative(this.root, path.resolve(abs));
    if (rel === '') return '';
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new AppError('The given path is outside of the sandbox.', { code: 'PATH_TRAVERSAL', status: 400 });
    }
    return rel.split(path.sep).join('/');
  }

  contains(abs) {
    const target = path.resolve(abs);
    return target === this.root || target.startsWith(this.root + path.sep);
  }

  /**
   * Resolve and additionally verify with realpath() that no symlink escapes
   * the sandbox. Used for reads/writes of existing paths.
   */
  async resolveExisting(input, options) {
    const abs = this.resolve(input, options);
    let real;
    try {
      real = await fsp.realpath(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Path does not exist yet: verify the closest existing parent instead.
        const parent = await this.realpathExistingParent(abs);
        if (!this.contains(parent)) {
          throw new AppError('The requested path escapes the sandbox through a link.', { code: 'PATH_TRAVERSAL', status: 400 });
        }
        return abs;
      }
      throw err;
    }
    if (!this.contains(real)) {
      throw new AppError('The requested path escapes the sandbox through a symbolic link.', { code: 'PATH_TRAVERSAL', status: 400 });
    }
    return real;
  }

  async realpathExistingParent(abs) {
    let current = path.dirname(abs);
    // Walk up until an existing directory is found (bounded to the root).
    for (let i = 0; i < 64; i += 1) {
      try {
        return await fsp.realpath(current);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        if (current === this.root || !this.contains(current)) return this.root;
        current = path.dirname(current);
      }
    }
    return this.root;
  }
}

/** Convenience: build a sandbox from a possibly relative path + project root. */
export function sandboxFor(projectRoot, dir) {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(projectRoot, dir);
  return new PathSandbox(abs);
}
