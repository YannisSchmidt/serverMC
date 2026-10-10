/**
 * Builds the bundled server-side admin mod (`mods-src/admin-tools`) and installs
 * the resulting jar into `minecraft/server/mods`.
 *
 * Why this exists: the mod is shipped as sources (see README section 18), so the
 * user has to compile it once. Doing it from the panel turns "read the docs, open
 * a terminal, run gradlew, copy a jar" into one button, and keeps the whole flow
 * visible in the console/logs.
 *
 * Security rules this service follows:
 *   - it never runs a shell: the Gradle wrapper is started with the **Java**
 *     runtime the user configured for Minecraft (`java`, already the only
 *     whitelisted executable besides `cloudflared`);
 *   - the project directory comes from the configuration, never from a request;
 *   - the build output is validated (a real jar, inside the project's
 *     `build/libs`, non-empty) before anything is copied into `mods/`;
 *   - uploaded/built jars are never executed by the panel: installing a mod only
 *     changes what the Minecraft server will load at its *next* start.
 *
 * The build itself is a normal Gradle run: it needs network access the first
 * time (Gradle distribution + NeoForge artefacts). Every failure is reported
 * with the reason, the last lines of the build output and a hint.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AppError } from '../util/errors.js';
import { spawnProcess, isWindows } from '../util/proc.js';
import { redactString } from '../util/redact.js';
import { EVENTS } from '../core/events.js';

export const ADMIN_MOD_STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

/** How many lines of build output are kept in memory for the panel. */
const LOG_TAIL = 400;
const WRAPPER_MAIN = 'org.gradle.wrapper.GradleWrapperMain';

export class AdminModService {
  constructor({ config, logs, events, java, mods, minecraft }) {
    this.config = config;
    this.logs = logs;
    this.events = events;
    this.java = java;
    this.mods = mods;
    this.minecraft = minecraft;

    this.state = ADMIN_MOD_STATES.IDLE;
    this.pending = false;
    this.pendingSince = null;
    this.child = null;
    this.logLines = [];
    this.lastBuild = null;
    this.startedAt = null;
  }

  get sourceDir() {
    return path.resolve(this.config.paths.projectRoot, String(this.config.values.admin_mod.source_dir || 'mods-src/admin-tools'));
  }

  get wrapperJar() {
    return path.join(this.sourceDir, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  }

  get buildLibsDir() {
    return path.join(this.sourceDir, 'build', 'libs');
  }

  get modsDir() {
    return path.join(this.config.paths.serverDir, 'mods');
  }

  isRunning() {
    return this.state === ADMIN_MOD_STATES.RUNNING || this.pending === true;
  }

  /**
   * The commands the mod registers, read straight out of its own sources.
   *
   * The panel lists exactly what the jar will register, so the documentation of
   * the Mods page cannot drift away from the mod: the three NAMES lists of the
   * command families are the single source of truth.
   */
  async commandList() {
    return AdminModService.readCommandLists(this.sourceDir);
  }

  /**
   * Same parse, usable without a service instance (the mod's own tests use it to
   * check that the documentation quotes the real numbers). Static on purpose: one
   * implementation, so the panel and the docs can never disagree.
   */
  static async readCommandLists(sourceDir) {
    const families = {
      admin: 'src/main/java/mcpanel/admintools/commands/AdminCommands.java',
      essentials: 'src/main/java/mcpanel/admintools/commands/EssentialsCommands.java',
      community: 'src/main/java/mcpanel/admintools/commands/CommunityCommands.java',
    };
    const out = {};
    let seen = false;
    for (const [family, relative] of Object.entries(families)) {
      const text = await readIfExists(path.join(sourceDir, relative));
      const block = /NAMES\s*=\s*List\.of\(([\s\S]*?)\);/.exec(text || '');
      const names = block ? [...block[1].matchAll(/"(\/[a-z][a-z-]*)"/g)].map((match) => match[1]) : [];
      out[family] = names;
      if (names.length) seen = true;
    }
    if (!seen) return null;
    const total = Object.values(out).reduce((sum, names) => sum + names.length, 0);
    return { families: out, total };
  }

  // ------------------------------------------------------------------ status

  /** Everything the Mods page needs, without starting anything. */
  async status() {
    const sourceDir = this.sourceDir;
    const wrapperJar = this.wrapperJar;
    const gradleProperties = path.join(sourceDir, 'gradle.properties');
    const settings = path.join(sourceDir, 'settings.gradle');

    const sourceTree = await exists(sourceDir);
    const wrapper = await exists(wrapperJar);
    const manifest = await readIfExists(gradleProperties);
    const project = await exists(settings);

    const version = /^mod_version\s*=\s*(.+)$/m.exec(manifest || '')?.[1]?.trim() || null;
    const minecraft = /^minecraft_version\s*=\s*(.+)$/m.exec(manifest || '')?.[1]?.trim() || null;
    const neoForge = /^neo_version\s*=\s*(.+)$/m.exec(manifest || '')?.[1]?.trim() || null;

    const builtJar = await this.findBuiltJar({ version });
    const installed = builtJar ? path.join(this.modsDir, builtJar.name) : version ? path.join(this.modsDir, `admintools-${version}.jar`) : null;
    const installedStat = installed ? await statIfExists(installed) : null;

    const java = await this.java.detect().catch((err) => ({ found: false, error: err.message }));
    const wrapperDistribution = await readIfExists(path.join(sourceDir, 'gradle', 'wrapper', 'gradle-wrapper.properties'));
    const distributionUrl = /^distributionUrl=(.+)$/m.exec(wrapperDistribution || '')?.[1]?.replace(/\\:/g, ':').trim() || null;

    return {
      state: this.state,
      running: this.isRunning(),
      available: sourceTree && wrapper && project,
      sourceDir,
      sourcePresent: sourceTree,
      wrapperPresent: wrapper,
      gradleVersion: /gradle-([\d.]+)-/.exec(distributionUrl || '')?.[1] || null,
      mod: { id: 'admintools', version, minecraftVersion: minecraft, neoForgeVersion: neoForge },
      commands: await this.commandList().catch(() => null),
      java: {
        found: Boolean(java?.found),
        path: java?.path || null,
        feature: java?.version?.feature ?? null,
        suitable: Boolean(java?.found && (java.version?.feature ?? 0) >= this.config.requiredJava),
        required: this.config.requiredJava,
      },
      jar: {
        built: Boolean(builtJar),
        path: builtJar?.path || null,
        file: builtJar?.name || null,
        size: builtJar?.size || null,
        builtAt: builtJar?.builtAt || null,
        installed: Boolean(installedStat),
        installedPath: installedStat ? installed : null,
        installedSize: installedStat?.size || null,
        installedAt: installedStat?.mtime?.toISOString() || null,
      },
      timeoutS: this.config.values.admin_mod.build_timeout_s,
      autoInstall: Boolean(this.config.values.admin_mod.auto_install),
      lastBuild: this.lastBuild,
      logTail: this.logLines.slice(-40),
      notes: buildNotes({ sourceTree, wrapper, java, suitable: Boolean(java?.found && (java.version?.feature ?? 0) >= this.config.requiredJava) }),
    };
  }

  /** The jar produced by the last successful build, if it is still there. */
  async findBuiltJar({ version = null } = {}) {
    let entries;
    try {
      entries = await fsp.readdir(this.buildLibsDir);
    } catch {
      return null;
    }
    const candidates = entries
      .filter((name) => name.endsWith('.jar') && !/-(sources|javadoc|dev|slim)\.jar$/.test(name))
      .filter((name) => !version || name === `admintools-${version}.jar`)
      .sort();
    const file = candidates.includes(`admintools-${version}.jar`) ? `admintools-${version}.jar` : candidates[0];
    if (!file) return null;
    const full = path.join(this.buildLibsDir, file);
    const stat = await statIfExists(full);
    if (!stat || stat.size === 0) return null;
    return { name: file, path: full, size: stat.size, builtAt: stat.mtime.toISOString() };
  }

  // ------------------------------------------------------------------- build

  /**
   * Run `gradlew build` through the configured JDK.
   *
   * @returns {Promise<{ok: boolean, jar: object|null, installed: boolean, restartRequired: boolean, message: string}>}
   */
  async build(options = {}) {
    // The state only becomes RUNNING once the pre-flight checks passed, so an
    // explicit flag also blocks the (short) window in which two concurrent
    // requests would both pass the checks and spawn two Gradle builds.
    if (this.pending || this.isRunning()) {
      throw new AppError('A build of the admin mod is already running.', {
        code: 'ADMIN_MOD_BUILD_RUNNING',
        status: 409,
        hint: 'Wait for the running build to finish (the Mods page streams its output).',
        details: { startedAt: this.startedAt ?? this.pendingSince ?? null },
      });
    }
    this.pending = true;
    this.pendingSince = Date.now();
    try {
      return await this.runBuild(options);
    } finally {
      this.pending = false;
      this.pendingSince = null;
    }
  }

  /** The actual build; `build()` owns the exclusivity guard. */
  async runBuild({ reason = 'panel request', timeoutMs = null, install = null, onLine = null } = {}) {
    const status = await this.status();
    if (!status.available) {
      throw new AppError('The sources of the admin mod were not found.', {
        code: 'ADMIN_MOD_SOURCES_MISSING',
        status: 404,
        hint: `Expected the Gradle project in ${status.sourceDir} (gradlew, gradle/wrapper/gradle-wrapper.jar, settings.gradle and src/main/java). Re-clone the repository or fix [admin_mod].source_dir.`,
        details: { sourceDir: status.sourceDir, wrapperPresent: status.wrapperPresent, sourcePresent: status.sourcePresent },
      });
    }
    if (!status.java.found) {
      throw new AppError(`Java was not found, so the admin mod cannot be built.`, {
        code: 'ADMIN_MOD_NO_JAVA',
        status: 409,
        hint: `Install a JDK ${this.config.requiredJava} (Eclipse Temurin) and set [minecraft].java_path in config/config.toml.`,
        details: { required: this.config.requiredJava },
      });
    }
    if (!status.java.suitable) {
      throw new AppError(`Java ${status.java.feature} is configured but the build needs Java ${this.config.requiredJava}.`, {
        code: 'ADMIN_MOD_JAVA_VERSION',
        status: 409,
        hint: `Point [minecraft].java_path at a JDK ${this.config.requiredJava} (the same one Minecraft uses) and retry.`,
        details: { found: status.java.feature, required: this.config.requiredJava, javaPath: status.java.path },
      });
    }

    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.config.values.admin_mod.build_timeout_s * 1000;
    const xmx = Math.min(Math.max(Number(this.config.values.admin_mod.build_xmx_mb) || 1024, 256), 16384);
    const args = [
      `-Xmx${xmx}m`,
      `-Dorg.gradle.appname=gradlew`,
      '-classpath', this.wrapperJar,
      WRAPPER_MAIN,
      '--no-daemon',
      '--console=plain',
      ...(isWindows() ? [] : ['--stacktrace']),
      'build',
    ];

    this.state = ADMIN_MOD_STATES.RUNNING;
    this.startedAt = Date.now();
    this.logLines = [];
    const startedAt = new Date().toISOString();
    this.log('info', `Building the admin mod (${reason}) with ${status.java.path}`);
    this.events?.publish(EVENTS.JOB, { job: 'admin-mod-build', state: 'running', reason, startedAt, jar: null, message: 'Compiling the admin mod…' });
    this.logs?.info?.(`[admin-mod] build started (${reason}) using ${status.java.path}`);

    this.lineSink = typeof onLine === 'function' ? onLine : null;
    let result;
    try {
      result = await this.spawnBuild({ args, timeout, startedAt });
    } finally {
      this.lineSink = null;
    }

    if (result.exitCode !== 0) {
      this.state = ADMIN_MOD_STATES.FAILED;
      this.child = null;
      this.lastBuild = { ...result, ok: false, finishedAt: new Date().toISOString() };
      this.events?.publish(EVENTS.JOB, { job: 'admin-mod-build', state: 'failed', message: result.error.message, reason });
      throw result.error;
    }

    const jar = await this.findBuiltJar({ version: status.mod.version });
    if (!jar) {
      this.state = ADMIN_MOD_STATES.FAILED;
      this.child = null;
      const error = new AppError('The build finished but no jar was produced.', {
        code: 'ADMIN_MOD_NO_JAR',
        status: 500,
        hint: 'Check the build output above: the jar is expected in build/libs/admintools-<version>.jar.',
        details: { libs: this.buildLibsDir, tail: this.logLines.slice(-20) },
      });
      this.lastBuild = { ...result, ok: false, finishedAt: new Date().toISOString(), error: { code: error.code, message: error.message } };
      throw error;
    }

    const shouldInstall = install === null ? Boolean(this.config.values.admin_mod.auto_install) : Boolean(install);
    let installedPath = null;
    if (shouldInstall) {
      installedPath = await this.installJar(jar, { reason });
    }

    this.state = ADMIN_MOD_STATES.SUCCEEDED;
    this.child = null;
    const restartRequired = this.minecraft ? this.minecraft.status().state !== 'stopped' : false;
    const message = installedPath
      ? `${jar.name} built and copied to minecraft/server/mods${restartRequired ? ' - restart the Minecraft server to load it' : ''}.`
      : `${jar.name} built in ${this.buildLibsDir} (installation disabled).`;
    this.lastBuild = {
      ...result, ok: true, finishedAt: new Date().toISOString(), jar, installedPath, restartRequired,
    };
    this.log('info', message);
    this.logs?.info?.(`[admin-mod] ${message}`);
    this.events?.publish(EVENTS.JOB, {
      job: 'admin-mod-build', state: 'done', message, jar: { file: jar.name, size: jar.size }, installed: Boolean(installedPath), restartRequired,
    });

    // Refresh the mod list so the new jar appears with its metadata.
    let mod = null;
    if (this.mods) {
      const list = await this.mods.list({ refresh: true }).catch(() => null);
      mod = list?.mods?.find((entry) => entry.file === (installedPath ? jar.name : jar.name)) || null;
    }
    return { ok: true, jar, installed: Boolean(installedPath), installedPath, restartRequired, message, mod, output: this.logLines.slice(-60) };
  }

  /** Spawn the wrapper and wait for the exit code, streaming the output. */
  spawnBuild({ args, timeout, startedAt }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnProcess(this.javaPath, args, {
          cwd: this.sourceDir,
          env: {
            // Gradle uses JAVA_HOME to locate the toolchain it compiles with.
            ...(deriveJavaHome(this.javaPath) ? { JAVA_HOME: deriveJavaHome(this.javaPath) } : {}),
            GRADLE_OPTS: '-Dorg.gradle.daemon=false',
            TERM: 'dumb',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          exitCode: -1,
          durationMs: 0,
          error: new AppError(`The build could not be started: ${err.message}`, {
            code: 'ADMIN_MOD_BUILD_FAILED',
            status: 500,
            hint: 'Check that [minecraft].java_path points at a Java executable and that the project directory is readable.',
            details: { javaPath: this.javaPath, args },
            cause: err,
          }),
        });
        return;
      }

      this.child = child;
      const consume = (stream, streamName) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) this.log(streamName, line);
        });
        stream.on('end', () => {
          if (buffer.trim()) this.log(streamName, buffer);
        });
      };
      consume(child.stdout, 'stdout');
      consume(child.stderr, 'stderr');

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.log('error', `Build timed out after ${Math.round(timeout / 1000)} s - stopping it.`);
        child.kill('SIGKILL');
      }, timeout);

      const finish = (exitCode, signal) => {
        clearTimeout(timer);
        const durationMs = Date.now() - Number(new Date(startedAt));
        if (timedOut) {
          resolve({
            exitCode: exitCode ?? -1,
            signal,
            durationMs,
            error: new AppError(`The build did not finish in ${Math.round(timeout / 1000)} s and was stopped.`, {
              code: 'ADMIN_MOD_BUILD_TIMEOUT',
              status: 504,
              hint: 'The first build downloads Gradle and the NeoForge artefacts: check your Internet connection, raise [admin_mod].build_timeout_s, or run `./gradlew build` in the project directory by hand.',
              details: { timeoutS: Math.round(timeout / 1000), tail: this.logLines.slice(-20) },
            }),
          });
          return;
        }
        if (exitCode === 0) {
          resolve({ exitCode: 0, signal, durationMs });
          return;
        }
        resolve({
          exitCode: exitCode ?? -1,
          signal,
          durationMs,
          error: new AppError(`The Gradle build failed (exit code ${exitCode ?? 'unknown'}${signal ? `, signal ${signal}` : ''}).`, {
            code: 'ADMIN_MOD_BUILD_FAILED',
            status: 500,
            hint: explainBuildFailure(this.logLines),
            details: { exitCode: exitCode ?? null, signal: signal ?? null, tail: this.logLines.slice(-40) },
          }),
        });
      };

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          exitCode: -1,
          durationMs: 0,
          error: new AppError(`The build process could not run: ${err.message}`, {
            code: 'ADMIN_MOD_BUILD_FAILED',
            status: 500,
            hint: 'Verify [minecraft].java_path and that the JDK can be executed by the panel.',
            details: { javaPath: this.javaPath },
            cause: err,
          }),
        });
      });
      child.on('exit', (code, signal) => finish(code, signal));
    });
  }

  /** Copy a built jar into minecraft/server/mods, replacing an older one. */
  async installJar(jar, { reason = '' } = {}) {
    const target = path.join(this.modsDir, jar.name);
    if (!path.resolve(target).startsWith(path.resolve(this.modsDir) + path.sep)) {
      throw new AppError('Refusing to install a jar outside of the mods directory.', { code: 'ADMIN_MOD_BAD_TARGET', status: 500 });
    }
    // Sanity check: a NeoForge mod jar must contain its metadata.
    const valid = await looksLikeModJar(jar.path);
    if (!valid.ok) {
      throw new AppError(`${jar.name} does not look like a NeoForge mod jar (${valid.reason}).`, {
        code: 'ADMIN_MOD_INVALID_JAR',
        status: 500,
        hint: 'The build output is probably not the final mod: run `./gradlew build` in the project directory and check the build output.',
        details: { jar: jar.path },
      });
    }
    await fsp.mkdir(this.modsDir, { recursive: true });
    const existing = await statIfExists(target);
    const tmp = `${target}.part-${process.pid}`;
    await fsp.copyFile(jar.path, tmp);
    await fsp.rename(tmp, target);
    this.log('info', `${existing ? 'Replaced' : 'Installed'} ${jar.name} in minecraft/server/mods (${jar.size} bytes)${reason ? ` [${reason}]` : ''}`);
    return target;
  }

  /** Kill a running build (used by the shutdown sequence). */
  async stop() {
    if (!this.child) return;
    this.log('warn', 'Stopping the running build.');
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    this.child = null;
    this.state = ADMIN_MOD_STATES.IDLE;
  }

  // ---------------------------------------------------------------- internal

  get javaPath() {
    const configured = this.config.values.minecraft.java_path;
    return configured && String(configured).trim() ? path.resolve(String(configured).trim()) : 'java';
  }

  log(stream, line) {
    const clean = redactString(String(line).replace(/\u001b\[[0-9;]*m/g, '')).slice(0, 4000);
    this.logLines.push({ ts: Date.now(), stream, line: clean });
    if (this.lineSink) {
      try {
        this.lineSink(clean, stream);
      } catch {
        /* a failing sink must never break the build */
      }
    }
    if (this.logLines.length > LOG_TAIL) this.logLines.splice(0, this.logLines.length - LOG_TAIL);
    this.events?.publish(EVENTS.JOB, { job: 'admin-mod-build', state: 'running', line: clean, stream });
  }
}

// -------------------------------------------------------------------- helpers

async function exists(target) {
  try {
    await fsp.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function statIfExists(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

async function readIfExists(target) {
  try {
    return await fsp.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/** `.../jdk-21/bin/java` -> `.../jdk-21` (only when the layout is unambiguous). */
function deriveJavaHome(javaPath) {
  if (!javaPath) return null;
  const bin = path.dirname(javaPath);
  if (path.basename(bin).toLowerCase() !== 'bin') return null;
  return path.dirname(bin);
}

/** A jar that NeoForge would load: a zip with META-INF/neoforge.mods.toml. */
async function looksLikeModJar(file) {
  try {
    const buffer = await fsp.readFile(file);
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      return { ok: false, reason: 'not a zip archive' };
    }
    // Look for the metadata path in the local file headers (cheap, no unzip).
    const needle = Buffer.from('META-INF/neoforge.mods.toml', 'utf8');
    return buffer.includes(needle)
      ? { ok: true }
      : { ok: false, reason: 'no META-INF/neoforge.mods.toml' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Turn the last build lines into an actionable hint. */
function explainBuildFailure(lines) {
  const text = lines.map((entry) => entry.line).join('\n');
  if (/Could not resolve|Could not download|Connection refused|UnknownHostException|Network is unreachable/i.test(text)) {
    return 'Gradle could not download the NeoForge artefacts: check the Internet connection (or your proxy) and retry.';
  }
  if (/Unsupported class file major version|requires at least JVM|Could not determine java version/i.test(text)) {
    return 'Gradle ran on the wrong Java runtime: point [minecraft].java_path at a JDK 21 and retry.';
  }
  if (/Permission denied|Access is denied/i.test(text)) {
    return 'Gradle could not write into the project directory: check the permissions of mods-src/admin-tools (build/ and .gradle/ must be writable).';
  }
  if (/Could not create service of type|Timeout waiting to lock/i.test(text)) {
    return 'Another Gradle process is holding the project lock: close other builds (or the daemon of another project) and retry.';
  }
  if (/error: /i.test(text)) {
    return 'The Java sources did not compile: the offending file and line are in the output above.';
  }
  return 'Read the build output above: Gradle always names the task, the file and the reason of the failure.';
}

function buildNotes({ sourceTree, wrapper, java, suitable }) {
  const notes = [];
  if (!sourceTree) notes.push('The project directory mods-src/admin-tools is missing: re-clone the repository or fix [admin_mod].source_dir.');
  else if (!wrapper) notes.push('gradle/wrapper/gradle-wrapper.jar is missing: the wrapper cannot start (run `./gradlew` once from a JDK 21).');
  if (!java?.found) notes.push('No Java runtime was detected: the mod cannot be compiled until a JDK is available.');
  else if (!suitable) notes.push(`Java ${java.version?.feature ?? '?'} is configured but a JDK ${java.version?.feature ? '' : ''}21+ is required to build the mod.`);
  notes.push('Building downloads Gradle and the NeoForge artefacts on the first run (a few hundred MB) - it needs Internet access.');
  return notes;
}
