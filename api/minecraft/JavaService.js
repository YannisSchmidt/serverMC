/**
 * Java detection.
 *
 * Finds a usable Java runtime (config path -> JAVA_HOME -> PATH -> common
 * install dirs), parses its version and checks it against the requirement of
 * the configured Minecraft version (1.21.1 -> Java 21).
 */

import path from 'node:path';
import { runCommand, resolveJavaCandidates, executableName } from '../util/proc.js';
import { AppError } from '../util/errors.js';

export function parseJavaVersion(output) {
  const text = String(output || '');
  // Examples:
  //   openjdk version "21.0.8" 2025-07-15 LTS
  //   java version "1.8.0_401"
  //   openjdk version "21.0.2" 2024-01-16
  const match = /(?:openjdk|java)\s+version\s+"([^"]+)"/i.exec(text) || /version\s+"([^"]+)"/i.exec(text);
  if (!match) return null;
  const raw = match[1];
  const parts = raw.split(/[._+-]/).map((p) => Number(p));
  const feature = parts[0] === 1 ? parts[1] : parts[0];
  // The vendor is best read from the runtime line ("OpenJDK Runtime Environment
  // Temurin-21.0.8+9"); the leading "openjdk version" line would otherwise win.
  const runtimeLine = /Runtime Environment\s+([^\s(]+)/i.exec(text);
  const VENDOR_RE = /(Temurin|Adoptium|Oracle|OpenJDK|Microsoft|GraalVM|Zulu|Corretto|Azul|Amazon|IBM|JetBrains|Liberica)/i;
  const vendorMatch = (runtimeLine && VENDOR_RE.exec(runtimeLine[1])) || VENDOR_RE.exec(text);
  const buildMatch = /(?:build|Build)\s+([^\s)]+)/.exec(text);
  const archMatch = /(?:64-Bit|64-bit|x86_64|aarch64|arm64|Server VM)/.exec(text);
  return {
    raw,
    feature: Number.isFinite(feature) ? feature : null,
    full: raw,
    vendor: vendorMatch ? vendorMatch[1] : 'unknown',
    build: buildMatch ? buildMatch[1] : null,
    bitness: archMatch ? '64-bit' : null,
  };
}

export class JavaService {
  /**
   * @param {object} deps
   * @param {import('../config/config.js').Config} deps.config
   * @param {import('../logging/logger.js').LogManager} deps.logs
   */
  constructor({ config, logs }) {
    this.config = config;
    this.log = logs.application.child('java');
    this.cache = null;
    this.cacheAt = 0;
  }

  get required() {
    return this.config.requiredJava || 21;
  }

  /** Inspect a single java executable. */
  async inspect(executable, { timeoutMs = 12000 } = {}) {
    const started = Date.now();
    try {
      // `java -version` writes to stderr on every known implementation.
      const { stdout, stderr, code } = await runCommand(executable, ['-version'], { timeoutMs });
      const combined = `${stderr}\n${stdout}`;
      const parsed = parseJavaVersion(combined);
      if (code !== 0 && !parsed) {
        return {
          ok: false,
          path: executable,
          error: `"${executable} -version" exited with code ${code} and did not report a Java version.`,
          hint: 'The path may point to something that is not a Java runtime.',
          output: combined.trim().slice(0, 400),
        };
      }
      return {
        ok: true,
        path: executable,
        version: parsed,
        output: combined.trim().slice(0, 400),
        ms: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        path: executable,
        error: err.code === 'ENOENT' ? `Java executable not found at "${executable}".` : `Could not run "${executable}": ${err.message}`,
        hint: err.code === 'ENOENT' ? 'Install a JDK 21 (Eclipse Temurin / Microsoft OpenJDK) or set [minecraft].java_path.' : undefined,
      };
    }
  }

  /** Detect the java runtime to use. Cached for 30 seconds. */
  async detect({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cacheAt < 30000) return this.cache;
    const configured = this.config.values.minecraft.java_path;
    const candidates = resolveJavaCandidates(configured);
    const attempts = [];
    for (const candidate of candidates) {
      // shell-style PATH lookups must be skipped when the file simply is not there
      const result = await this.inspect(candidate);
      attempts.push({ path: candidate, ok: result.ok, error: result.error });
      if (result.ok && result.version?.feature) {
        const meets = result.version.feature >= this.required;
        const exact = result.version.feature === this.required;
        // A configured [minecraft].java_path that does not work must never be
        // replaced quietly by whatever else is on this machine: the operator has
        // to see which runtime is really used, otherwise a wrong JDK turns into
        // "it starts and then crashes" with nothing to explain it.
        const wanted = configured && configured.trim() ? path.resolve(configured.trim()) : null;
        const fallbackFrom = wanted && path.resolve(candidate) !== wanted ? wanted : null;
        const detection = {
          found: true,
          path: candidate,
          version: result.version,
          requiredJava: this.required,
          meetsRequirement: meets,
          exact,
          state: meets ? (exact ? 'ok' : 'newer') : 'too_old',
          fallbackFrom,
          attempts,
          checkedAt: new Date().toISOString(),
          detail: this.describe(result.version, meets, exact)
            + (fallbackFrom
              ? ` Note: [minecraft].java_path points at "${fallbackFrom}", which does not work - the runtime above was found instead. Fix java_path or remove it to keep using auto-detection.`
              : ''),
        };
        this.cache = detection;
        this.cacheAt = Date.now();
        return detection;
      }
    }
    const detection = {
      found: false,
      path: null,
      version: null,
      requiredJava: this.required,
      meetsRequirement: false,
      state: 'missing',
      fallbackFrom: configured?.trim() ? path.resolve(configured.trim()) : null,
      attempts,
      checkedAt: new Date().toISOString(),
      error: 'Java was not found.',
      hint: `Minecraft ${this.config.values.minecraft.version} with NeoForge ${this.config.values.minecraft.neoforge_version} needs Java ${this.required}. Install Eclipse Temurin ${this.required} (https://adoptium.net) and either add it to PATH or set [minecraft].java_path in config/config.toml.`,
    };
    this.cache = detection;
    this.cacheAt = Date.now();
    return detection;
  }

  describe(version, meets, exact) {
    if (!meets) return `Java ${version.feature} found at ${version.full}, but Java ${this.required} or newer is required.`;
    if (!exact) return `Java ${version.feature} (${version.vendor}) is newer than the tested Java ${this.required}; it will be used, but NeoForge may refuse very new runtimes.`;
    return `Java ${version.feature} (${version.vendor}, ${version.full}) is exactly what Minecraft ${this.config.values.minecraft.version} expects.`;
  }

  /** All java installations that can be found (Settings dropdown). */
  async listCandidates() {
    const found = [];
    for (const candidate of resolveJavaCandidates('')) {
      const result = await this.inspect(candidate);
      if (result.ok) found.push({ path: candidate, version: result.version });
    }
    if (found.length === 0) {
      const wellKnown = await this.scanWellKnown();
      found.push(...wellKnown);
    }
    return found;
  }

  async scanWellKnown() {
    const { readdir } = await import('node:fs/promises');
    const results = [];
    const roots = process.platform === 'win32'
      ? ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft', 'C:\\Program Files\\Zulu']
      : ['/usr/lib/jvm', '/opt/java', '/Library/Java/JavaVirtualMachines'];
    for (const root of roots) {
      let entries = [];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = process.platform === 'darwin'
          ? path.join(root, entry.name, 'Contents', 'Home', 'bin', executableName('java'))
          : path.join(root, entry.name, 'bin', executableName('java'));
        const result = await this.inspect(candidate);
        if (result.ok) results.push({ path: candidate, version: result.version });
      }
    }
    return results;
  }

  /** Throwing variant used before starting the server. */
  async requireUsable() {
    const detection = await this.detect({ force: true });
    if (!detection.found) {
      throw new AppError(detection.error || 'Java was not found on this computer.', {
        code: 'JAVA_NOT_FOUND',
        status: 500,
        hint: detection.hint,
        details: { attempts: detection.attempts?.slice(0, 5) },
      });
    }
    if (!detection.meetsRequirement) {
      throw new AppError(
        `Java ${detection.version.feature} is installed at ${detection.path}, but Minecraft ${this.config.values.minecraft.version} needs Java ${this.required}.`,
        {
          code: 'JAVA_VERSION_MISMATCH',
          status: 500,
          hint: `Install Java ${this.required} (e.g. Eclipse Temurin ${this.required}) and set [minecraft].java_path or JAVA_HOME.`,
        },
      );
    }
    return detection;
  }

  invalidate() {
    this.cache = null;
    this.cacheAt = 0;
  }

  status() {
    return this.cache || { found: false, state: 'unknown', requiredJava: this.required };
  }
}
