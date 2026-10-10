/**
 * File + console logger with rotation and mandatory secret redaction.
 *
 * Channels (one rotating file each, as requested by the project spec):
 *   logs/application.log, logs/minecraft.log, logs/e4mc.log, logs/cloudflare.log
 *
 * Nothing that looks like a credential can be written: `redact()` runs on the
 * message and on every metadata value before serialisation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ensureDirSync } from '../util/fsx.js';
import { redact, redactString } from '../util/redact.js';

export const LOG_CHANNELS = ['application', 'minecraft', 'e4mc', 'cloudflare', 'playit'];
export const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS = {
  debug: '\u001b[90m',
  info: '\u001b[36m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  reset: '\u001b[0m',
  dim: '\u001b[2m',
};

function timestamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}`;
}

/**
 * One `error` listener on stdout/stderr for the whole process: several
 * LogManager instances (tests, short-lived CLI runs) must not pile up listeners.
 */
const consoleGuardListenersInstalled = { value: false };
const guardedLoggers = new Set();

/**
 * Attach one `error` listener per stream that switches every known logger to
 * file-only output. `streams` is injectable for tests; by default it is the two
 * process streams, and that path is installed only once per process.
 */
export function guardConsoleStreams(loggers, streams = null) {
  const targets = streams || [['stdout', process.stdout], ['stderr', process.stderr]];
  for (const logger of loggers) guardedLoggers.add(logger);
  if (!streams) {
    if (consoleGuardListenersInstalled.value) return;
    consoleGuardListenersInstalled.value = true;
  }
  for (const [name, stream] of targets) {
    if (!stream?.on) continue;
    stream.on('error', (err) => {
      const reason = err?.code === 'EPIPE' ? `${name} was closed` : `${name}: ${err?.message || 'unknown stream error'}`;
      for (const logger of guardedLoggers) logger.dropConsole(reason);
    });
  }
}

export class Logger extends EventEmitter {
  constructor({ channel, file, level = 'info', maxFileBytes = 8 * 1024 * 1024, maxFiles = 5, console = true, consoleStreams = null, bufferSize = 500 }) {
    super();
    this.channel = channel;
    this.file = file;
    this.level = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.levelName = level;
    this.maxFileBytes = maxFileBytes;
    this.maxFiles = maxFiles;
    this.console = console;
    // Injectable so a test (or a caller that wants its own console) can supply
    // the streams instead of the process ones.
    this.consoleStreams = consoleStreams || { out: process.stdout, err: process.stderr };
    this.buffer = [];
    this.bufferSize = bufferSize;
    if (file) {
      ensureDirSync(path.dirname(file));
      this._rotateIfNeeded();
    }
  }

  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this.level = LOG_LEVELS[level];
      this.levelName = level;
    }
  }

  /**
   * Stop writing to the console, for good, and say why in the log file.
   * Called when the console stream fails (EPIPE) or is closed by the user.
   */
  dropConsole(reason) {
    if (this.consoleFailed) return;
    this.consoleFailed = true;
    this.console = false;
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, `${timestamp()} [WARN ] [${this.channel}] Console output disabled (${reason}); logging continues in ${this.file}.\n`, 'utf8');
    } catch {
      /* the log file is the last resort: never throw from a logger */
    }
  }

  child(prefix) {
    const parent = this;
    return {
      debug: (m, meta) => parent.debug(`[${prefix}] ${m}`, meta),
      info: (m, meta) => parent.info(`[${prefix}] ${m}`, meta),
      warn: (m, meta) => parent.warn(`[${prefix}] ${m}`, meta),
      error: (m, meta) => parent.error(`[${prefix}] ${m}`, meta),
    };
  }

  log(levelName, message, meta) {
    if ((LOG_LEVELS[levelName] ?? LOG_LEVELS.info) < this.level) return;
    const text = typeof message === 'string' ? redactString(message) : String(message);
    const safeMeta = meta === undefined ? undefined : redact(meta);
    const record = {
      ts: new Date().toISOString(),
      channel: this.channel,
      level: levelName,
      message: text,
      meta: safeMeta && Object.keys(safeMeta).length ? safeMeta : undefined,
    };
    const metaText = record.meta ? ` ${JSON.stringify(record.meta)}` : '';
    const line = `${timestamp()} [${levelName.toUpperCase().padEnd(5)}] [${this.channel}] ${text}${metaText}`;

    if (this.console) {
      const color = COLORS[levelName] || '';
      const stream = levelName === 'error' || levelName === 'warn' ? this.consoleStreams.err : this.consoleStreams.out;
      try {
        stream.write(`${COLORS.dim}${timestamp()}${COLORS.reset} ${color}${levelName.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.dim}[${this.channel}]${COLORS.reset} ${text}${metaText}\n`);
      } catch (err) {
        // The console can go away while the panel keeps running (the start.bat
        // window was closed, the output was piped to a program that exited...):
        // drop console output and keep logging to the file instead of crashing.
        this.dropConsole(err?.code === 'EPIPE' ? 'the console was closed' : err?.message || 'the console could not be written to');
      }
    }
    if (this.file) {
      try {
        this._rotateIfNeeded();
        fs.appendFileSync(this.file, `${line}\n`, 'utf8');
      } catch {
        /* logging must never crash the app */
      }
    }
    this.buffer.push(record);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.emit('record', record);
  }

  debug(message, meta) {
    this.log('debug', message, meta);
  }

  info(message, meta) {
    this.log('info', message, meta);
  }

  warn(message, meta) {
    this.log('warn', message, meta);
  }

  error(message, meta) {
    this.log('error', message, meta);
  }

  /** Rotate `file` -> `file.1` -> `file.2` ... when it exceeds maxFileBytes. */
  _rotateIfNeeded() {
    if (!this.file) return;
    let stats;
    try {
      stats = fs.statSync(this.file);
    } catch {
      return;
    }
    if (stats.size < this.maxFileBytes) return;
    try {
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
        const to = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
    } catch {
      /* ignore rotation failures */
    }
  }

  /** Last N parsed records (live view for the panel). */
  tail(limit = 200) {
    return this.buffer.slice(-limit);
  }
}

/** Registry of all channel loggers, shared by every service. */
export class LogManager {
  constructor(config, { console = true, consoleStreams = null } = {}) {
    this.config = config;
    this.channels = new Map();
    const dir = config.paths.logsDir;
    const settings = config.values.logging;
    ensureDirSync(dir);
    for (const channel of LOG_CHANNELS) {
      const logger = new Logger({
        channel,
        file: path.join(dir, `${channel}.log`),
        level: settings.level,
        maxFileBytes: settings.max_file_mb * 1024 * 1024,
        maxFiles: settings.max_files,
        console: console && channel === 'application',
        consoleStreams,
        bufferSize: 1000,
      });
      this.channels.set(channel, logger);
    }
    this.application = this.get('application');
    this.minecraft = this.get('minecraft');
    this.e4mc = this.get('e4mc');
    this.cloudflare = this.get('cloudflare');
    this.playit = this.get('playit');
    // An EPIPE on stdout/stderr is not a crash: it means nobody is reading the
    // console any more (closed window, broken pipe). Never let it bubble up.
    this._guardConsoleStreams();
  }

  /** Mark console logging as dead when the process streams report an error. */
  _guardConsoleStreams() {
    guardConsoleStreams(this.channels.values());
  }

  get(channel) {
    const logger = this.channels.get(channel);
    if (!logger) throw new Error(`Unknown log channel "${channel}" (known: ${LOG_CHANNELS.join(', ')})`);
    return logger;
  }

  setLevel(level) {
    for (const logger of this.channels.values()) logger.setLevel(level);
  }

  /** Read the tail of a log file straight from disk (used by the log viewer). */
  async readFile(channel, { lines = 300 } = {}) {
    const logger = this.get(channel);
    if (!logger.file) return [];
    let raw = '';
    try {
      raw = await fs.promises.readFile(logger.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const all = raw.split('\n').filter(Boolean);
    return all.slice(-Math.max(1, Math.min(lines, 5000))).map((line) => redactString(line));
  }
}
