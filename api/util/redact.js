/**
 * Secret redaction.
 *
 * Nothing that looks like a credential may ever reach a log file, an API
 * response or the console of the UI. `redact()` is applied centrally in the
 * logger and is also exported for HTTP error paths.
 */

// A key is a secret when its normalized name is one of these...
const SECRET_KEYS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'auth', 'authorization',
  'cookie', 'setcookie', 'session', 'sessionid', 'credentials', 'credential',
  'apikey', 'apitoken', 'bearer', 'privatekey', 'zonekey',
  'wakecode', 'powercode',
]);

// ...or when it contains one of these (composite names: `api_token`,
// `cloudflare_api_token`, `mcpanel_session`, `MYSQL_PASSWORD`, ...).
const SECRET_KEY_PARTS = [
  'password', 'passwd', 'passphrase', 'apikey', 'apitoken', 'accesstoken',
  'refreshtoken', 'authtoken', 'authkey', 'bearer', 'clientsecret',
  'privatekey', 'cloudflareapitoken', 'zonekey', 'sessionid', 'sessiontoken',
  'credential', 'secretkey', 'sharedsecret', 'wakecode', 'powercode',
];

const SECRET_PATTERNS = [
  // Cloudflare API tokens & generic long opaque tokens (40+ chars)
  /\b[A-Za-z0-9_-]{40,}\b/g,
  // JWT / Minecraft session tokens (three dot-separated parts)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Cloudflare tunnel tokens
  /\beyJ[A-Za-z0-9._-]{60,}\b/g,
  // Authorization headers first, so the whole header is replaced as one unit
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // key=value / key: value style secrets in free text ("token=abc", 'password: "x"')
  // (the optional leading `NAME_` part catches CLOUDFLARE_API_TOKEN=, MYSQL_PASSWORD=, ...)
  /(?:(?:[A-Za-z0-9]+[_.-])*(token|api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|auth(?:orization)?|session[_-]?id|cookie|wake[_-]?code|power[_-]?code))\s*[=:]\s*("?)[^\s"',;]+\2/gi,
];

export const REDACTED = '[redacted]';

function isSecretKey(key) {
  // Normalize `apiToken`, `api_token`, `API-TOKEN` and `X-Api-Token` alike.
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!k) return false;
  if (SECRET_KEYS.has(k)) return true;
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

/** Mask a single value. */
export function maskValue(value) {
  if (value === null || value === undefined) return value;
  const str = String(value);
  if (str.length <= 4) return REDACTED;
  return `${str.slice(0, 2)}${'*'.repeat(Math.min(8, str.length - 4))}${str.slice(-2)}`;
}

/** True when a value should never be sent to a client. */
export function isSecretKeyName(key) {
  return isSecretKey(key);
}

/**
 * Recursively redact secrets from any structure.
 * Returns a new value; the input is never mutated.
 */
export function redact(input, { depth = 0, keepSecrets = false } = {}) {
  if (depth > 8) return '[deep]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactString(input);
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint') return input;
  if (typeof input === 'function') return '[function]';
  if (input instanceof Error) {
    return { name: input.name, code: input.code, message: redactString(input.message) };
  }
  if (Array.isArray(input)) return input.map((v) => redact(v, { depth: depth + 1, keepSecrets }));
  if (input instanceof Map) {
    return Object.fromEntries([...input.entries()].map(([k, v]) => [k, redact(v, { depth: depth + 1, keepSecrets })]));
  }
  if (typeof input === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (!keepSecrets && isSecretKey(key) && value) out[key] = maskValue(value);
      else out[key] = redact(value, { depth: depth + 1, keepSecrets });
    }
    return out;
  }
  return input;
}

/** Redact secrets embedded in a free-form string (log lines, error messages). */
export function redactString(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
