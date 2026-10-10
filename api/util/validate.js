/**
 * Small validation helpers. Every value that comes from HTTP, the CLI or the
 * configuration file is validated with these before it is used.
 */

import { ValidationError } from './errors.js';

export const MC_USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;
export const MC_UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
export const SEMVER_LIKE_RE = /^\d+(\.\d+){1,3}([-+][A-Za-z0-9.+-]+)?$/;
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
export const KEY_RE = /^[A-Za-z0-9._\-[\]]{1,128}$/;

export function asString(value, field, { min = 0, max = 10000, trim = true, allowEmpty = true, pattern = null } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty && min === 0) return '';
    throw new ValidationError(`"${field}" is required.`);
  }
  if (typeof value !== 'string') throw new ValidationError(`"${field}" must be a string.`);
  const out = trim ? value.trim() : value;
  if (!allowEmpty && out.length === 0) throw new ValidationError(`"${field}" must not be empty.`);
  if (out.length < min) throw new ValidationError(`"${field}" must be at least ${min} characters.`);
  if (out.length > max) throw new ValidationError(`"${field}" must be at most ${max} characters.`);
  if (pattern && out.length > 0 && !pattern.test(out)) throw new ValidationError(`"${field}" has an invalid format.`);
  return out;
}

export function asInt(value, field, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`"${field}" is required.`);
  }
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new ValidationError(`"${field}" must be an integer.`);
  if (num < min) throw new ValidationError(`"${field}" must be >= ${min}.`);
  if (num > max) throw new ValidationError(`"${field}" must be <= ${max}.`);
  return num;
}

export function asBool(value, field, { fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`"${field}" is required.`);
  }
  if (typeof value === 'boolean') return value;
  const str = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(str)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(str)) return false;
  if (fallback !== undefined) return fallback;
  throw new ValidationError(`"${field}" must be a boolean (true/false).`);
}

export function asStringArray(value, field, { max = 200, maxItem = 512 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const arr = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  if (arr.length > max) throw new ValidationError(`"${field}" must not contain more than ${max} entries.`);
  return arr
    .map((v) => (typeof v === 'string' ? v.trim() : String(v)))
    .filter((v) => v.length > 0)
    .map((v) => {
      if (v.length > maxItem) throw new ValidationError(`An entry of "${field}" is too long (max ${maxItem} characters).`);
      return v;
    });
}

export function assertUsername(value, field = 'player') {
  const name = asString(value, field, { min: 1, max: 16, allowEmpty: false });
  if (!MC_USERNAME_RE.test(name)) {
    throw new ValidationError(`"${field}" is not a valid Minecraft username (letters, digits and "_" only, 1-16 characters).`);
  }
  return name;
}

export function assertUuid(value, field = 'uuid') {
  const uuid = asString(value, field, { min: 32, max: 36, allowEmpty: false });
  if (!MC_UUID_RE.test(uuid)) throw new ValidationError(`"${field}" is not a valid UUID.`);
  return uuid;
}

export function assertPort(value, field = 'port') {
  return asInt(value, field, { min: 1, max: 65535 });
}

export function assertVersionLike(value, field = 'version') {
  const version = asString(value, field, { min: 1, max: 64, allowEmpty: false });
  if (!SEMVER_LIKE_RE.test(version)) throw new ValidationError(`"${field}" must look like a version number (e.g. 1.21.1).`);
  return version;
}

export function assertHostname(value, field = 'hostname') {
  const host = asString(value, field, { min: 1, max: 253, allowEmpty: false }).toLowerCase();
  if (!HOSTNAME_RE.test(host)) throw new ValidationError(`"${field}" is not a valid domain name.`);
  return host;
}

export function assertEnum(value, field, allowed, { fallback } = {}) {
  const str = String(value ?? '').trim();
  if (allowed.includes(str)) return str;
  if (fallback !== undefined) return fallback;
  throw new ValidationError(`"${field}" must be one of: ${allowed.join(', ')}.`);
}

/**
 * Quote an argument for a Minecraft console command. Only used for
 * components such as reasons/messages. Never for shell commands.
 */
export function mcQuote(value, { max = 256 } = {}) {
  const str = String(value ?? '').replace(/[\u0000-\u001f\u00a7\r\n]/g, ' ').trim().slice(0, max);
  return str.replace(/"/g, "'");
}
