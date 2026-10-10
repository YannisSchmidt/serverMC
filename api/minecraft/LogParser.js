/**
 * Parses the stdout/stderr of the Minecraft (NeoForge) server.
 *
 * Every pattern below is taken from real server output of vanilla 1.21.x and
 * NeoForge 21.1.x; the parser never guesses global state from a single line,
 * it only reports what it actually saw. `interpret()` is pure (line in, event
 * out) which is what makes it unit-testable with captured log files.
 */

const TIME_RE = /^\[(\d{2}:\d{2}:\d{2})\]/;
const THREAD_LEVEL_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s*\[([^\]/]+)\/([A-Z]+)\]:?\s?(.*)$/;
const LEVEL_IN_TEXT_RE = /^\s*\[([^\]/]+)\/([A-Z]+)\]:\s*(.*)$/;
const USERNAME = '([A-Za-z0-9_]{1,16})';

/** Remove ANSI escapes (JLine colour) and Minecraft formatting codes. */
export function stripFormatting(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\u00a7[0-9a-fk-orx]/gi, '')
    .replace(/\r/g, '');
}

/** Split a raw line into { time, thread, level, message }. */
export function parseLogPrefix(raw) {
  const line = stripFormatting(raw);
  const match = THREAD_LEVEL_RE.exec(line);
  if (match) {
    return { time: match[1], thread: match[2].trim(), level: match[3], message: match[4], raw: line };
  }
  const short = LEVEL_IN_TEXT_RE.exec(line);
  if (short) return { time: null, thread: short[1].trim(), level: short[2], message: short[3], raw: line };
  const timeOnly = TIME_RE.exec(line);
  if (timeOnly) return { time: timeOnly[1], thread: null, level: null, message: line.slice(timeOnly[0].length).trim(), raw: line };
  return { time: null, thread: null, level: null, message: line.trim(), raw: line };
}

/**
 * Error signatures: pattern -> precise (never bare) explanation + fix hint.
 * Ordered: the first match wins.
 */
export const ERROR_SIGNATURES = [
  {
    code: 'EULA_NOT_ACCEPTED',
    test: /You need to agree to the EULA|agreed? to the EULA in order to run the server|eula=false/i,
    message: 'Minecraft refused to start because the EULA was not accepted.',
    hint: 'Run the install step (Settings → Install → Accept the EULA) or set eula=true in minecraft/server/eula.txt.',
  },
  {
    code: 'PORT_IN_USE',
    test: /FAILED TO BIND TO PORT|Perhaps a server is already running on that port|Address already in use|bind failed/i,
    message: 'The Minecraft port is already in use: another server (or another program) is bound to it.',
    hint: 'Stop the other process or choose another port in Settings → Minecraft port.',
  },
  {
    code: 'WRONG_JAVA_VERSION',
    test: /Unsupported class file major version|has been compiled by a more recent version of the Java Runtime|UnsupportedClassVersionError/i,
    message: 'Minecraft was started with a Java version that is too old.',
    hint: 'Install Java 21 (Eclipse Temurin) and set the correct path in Settings → Java executable (java_path).',
  },
  {
    code: 'OUT_OF_MEMORY',
    test: /java\.lang\.OutOfMemoryError|Could not reserve enough space for object heap|Java heap space/i,
    message: 'Java ran out of memory while running Minecraft.',
    hint: 'Increase "Maximum RAM" in Settings, or remove heavy mods. Leave at least 2 GB free for the system.',
  },
  {
    code: 'JVM_CRASH',
    test: /A fatal error has been detected by the Java Runtime Environment|SIGSEGV|EXCEPTION_ACCESS_VIOLATION/i,
    message: 'The Java virtual machine crashed (hs_err file written in minecraft/server).',
    hint: 'Usually a native mod or an incompatible Java version. Check logs/minecraft.log and the hs_err_pid*.log file.',
  },
  {
    code: 'MIXIN_FAILURE',
    test: /Mixin apply failed|MixinApplyError|org\.spongepowered\.asm\.mixin\.MixinException/i,
    message: 'A mod failed to inject (Mixin) into the game, the server refuses to continue.',
    hint: 'The named mod is not compatible with this NeoForge/Minecraft version: update it or move the jar out of mods/.',
  },
  {
    code: 'MOD_LOAD_FAILURE',
    test: /Failed to load mod|Mod file .* failed|mods\.toml.*(not found|invalid)|Missing or unsupported mandatory dependencies/i,
    message: 'A mod in minecraft/server/mods could not be loaded.',
    hint: 'Read the lines above to find the jar name, then disable or update that mod on the Mods page.',
  },
  {
    code: 'WORLD_CORRUPT',
    test: /Failed to load (level|world)|Exception loading (chunk|world)|world.*corrupt/i,
    message: 'The world could not be loaded: its files appear to be damaged.',
    hint: 'Restore a backup from the Backups page (the panel keeps a safety backup before every restore).',
  },
  {
    code: 'PERMISSION_DENIED',
    test: /AccessDeniedException|Permission denied|Zugriff verweigert/i,
    message: 'Minecraft could not read or write a file: permission denied.',
    hint: 'Make sure the user that starts the panel owns minecraft/server (chown/chmod on Linux, properties on Windows).',
  },
  {
    code: 'JAVA_NOT_FOUND',
    test: /java: (command )?not found|'java' is not recognized|CreateProcess error=2/i,
    message: 'The Java executable could not be launched.',
    hint: 'Check the "java_path" setting and that Java 21 is installed.',
  },
  {
    code: 'MINECRAFT_JAR_MISSING',
    test: /Unable to access jarfile|Could not find or load main class|No such file or directory.*\.jar/i,
    message: 'The Minecraft/NeoForge server jar could not be found or read.',
    hint: 'Run Settings → Install / Repair to download the vanilla jar and the NeoForge installer output again.',
  },
  {
    code: 'SERVER_CRASH',
    test: /Encountered an unexpected exception|The game crashed|Exception in thread "main"/i,
    message: 'Minecraft stopped because of an unexpected exception.',
    hint: 'Read the stack trace above; the last "Caused by:" line names the real culprit (often a mod).',
  },
];

export const PATTERNS = {
  starting: new RegExp(`Starting minecraft server version\\s+([\\w.\\-+]+)`, 'i'),
  startingGeneric: /Starting minecraft server version/i,
  vanillaJar: /Unable to access jarfile|Could not find or load main class/i,
  neoforgeVersion: /NeoForge (?:mod loading, )?version[:\s]+([\w.\-+]+)/i,
  neoforgeLoadingMods: /NeoForge version[\w.\s,\-+]*loading\s+(\d+)\s+mods/i,
  preparing: /Preparing (level|start region|spawn area)/i,
  done: /Done \(([\d.,]+)s\)!\s*For help, type "help"/i,
  stopping: /Stopping (the )?server|Stopping the server/i,
  saving: /Saving (the )?(worlds|players|world|chunks)/i,
  joined: new RegExp(`${USERNAME} joined the game`),
  left: new RegExp(`${USERNAME} left the game`),
  lostConnection: new RegExp(`${USERNAME} lost connection: (.*)$`),
  kicked: new RegExp(`Kicked ${USERNAME}:\\s*(.*)$`),
  listResponse: /There are (\d+) of a max(?:imum)? of (\d+) players online:?\s*(.*)$/i,
  tickRates: /(?:Server )?tick times \(avg\/min\/max\)[^:]*:\s*([\d.,]+)\/([\d.,]+)\/([\d.,]+)\s*ms/i,
  tickPercentile: /P50[:=]?\s*([\d.,]+)\s*ms/i,
  averageTickTime: /Average (?:tick time|time per tick):\s*([\d.,]+)\s*ms/i,
  targetTickRate: /Target tick rate:\s*([\d.,]+)/i,
  lagging: /Can't keep up!|Running (\d+)ms or (\d+) ticks behind/i,
  whitelistEnforced: /Whitelist is (?:now )?enforced|whitelist is enabled/i,
  playerCommandDenied: /Unknown or incomplete command|is not a valid player name|That player does not exist/i,
  modCount: /Loading (\d+) mods/i,
  serverProperties: /Loading properties/i,
  listening: /Starting Minecraft server on (\S+)/i,
};

const NUMBER = (value) => {
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Interpret a single server line. Returns an event object or null. */
export function interpret(rawLine) {
  const parsed = parseLogPrefix(rawLine);
  const text = parsed.message;
  if (!text) return null;
  const base = { line: parsed.raw, text, ts: parsed.time, thread: parsed.thread, level: parsed.level };

  let match = PATTERNS.done.exec(text);
  if (match) return { type: 'online', seconds: NUMBER(match[1]), ...base };

  match = PATTERNS.starting.exec(text);
  if (match) return { type: 'starting', version: match[1], ...base };
  if (PATTERNS.startingGeneric.test(text)) return { type: 'starting', version: null, ...base };

  match = PATTERNS.neoforgeLoadingMods.exec(text);
  if (match) {
    const versionMatch = PATTERNS.neoforgeVersion.exec(text);
    return { type: 'version', neoforge: versionMatch ? versionMatch[1] : null, neoforgeVersion: versionMatch ? versionMatch[1] : null, modCount: Number(match[1]), ...base };
  }
  match = PATTERNS.neoforgeVersion.exec(text);
  if (match) return { type: 'version', neoforge: match[1], neoforgeVersion: match[1], ...base };

  match = PATTERNS.listResponse.exec(text);
  if (match) {
    const names = (match[3] || '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name && name.toLowerCase() !== 'and more');
    return { type: 'list', online: Number(match[1]), max: Number(match[2]), players: names, ...base };
  }

  match = PATTERNS.joined.exec(text);
  if (match) return { type: 'joined', player: match[1], ...base };
  match = PATTERNS.left.exec(text);
  if (match) return { type: 'left', player: match[1], ...base };
  match = PATTERNS.lostConnection.exec(text);
  if (match) return { type: 'left', player: match[1], reason: `connection lost: ${match[2]}`, ...base };
  match = PATTERNS.kicked.exec(text);
  if (match) return { type: 'left', player: match[1], reason: `kicked: ${match[2]}`, ...base };

  match = PATTERNS.tickRates.exec(text);
  if (match) {
    const avg = NUMBER(match[1]);
    const p50 = NUMBER(match[2]);
    return { type: 'performance', mspt: avg, p50, min: NUMBER(match[2]), max: NUMBER(match[3]), source: 'tick query', ...base };
  }
  match = PATTERNS.tickPercentile.exec(text);
  if (match) return { type: 'performance', p50: NUMBER(match[1]), source: 'tick query', ...base };
  match = PATTERNS.averageTickTime.exec(text);
  if (match) return { type: 'performance', mspt: NUMBER(match[1]), source: 'average tick time', ...base };
  match = PATTERNS.targetTickRate.exec(text);
  if (match) return { type: 'tickrate', target: NUMBER(match[1]), ...base };
  match = PATTERNS.lagging.exec(text);
  if (match) {
    const behind = /(\d+)ms or (\d+) ticks/.exec(text);
    return { type: 'lagging', behindMs: behind ? NUMBER(behind[1]) : null, behindTicks: behind ? NUMBER(behind[2]) : null, ...base };
  }

  // Error signatures are checked before the benign status patterns: the EULA
  // refusal and "port already in use" are printed at INFO/WARN level, but they
  // are the actual reason why the server did not come up.
  const error = matchError(text);
  if (error) return { type: 'error', error, ...base };

  if (PATTERNS.listening.test(text)) return { type: 'listening', ...base };
  if (PATTERNS.preparing.test(text)) return { type: 'preparing', ...base };
  if (PATTERNS.saving.test(text)) return { type: 'saving', ...base };
  if (PATTERNS.stopping.test(text)) return { type: 'stopping', ...base };
  return { type: 'line', ...base };
}

/** Find a precise diagnosis for a suspicious line. */
export function matchError(text) {
  for (const signature of ERROR_SIGNATURES) {
    if (signature.test.test(text)) {
      return {
        code: signature.code,
        message: signature.message,
        hint: signature.hint,
        detail: stripFormatting(text).slice(0, 500),
      };
    }
  }
  if (/^(Exception|Error)[:\s]|^\s+at |Caused by:/i.test(text)) {
    return {
      code: 'JAVA_EXCEPTION',
      message: `Minecraft reported a Java exception: ${stripFormatting(text).slice(0, 200)}`,
      hint: 'The lines above usually name the mod or the world file that caused it.',
      detail: stripFormatting(text).slice(0, 500),
    };
  }
  return null;
}

/**
 * Stateful view over the stream: tracks players, versions, TPS and failures.
 */
export class LogParser {
  /**
   * @param {object} [options]
   * @param {(event: object) => void} [options.onEvent] state callback
   * @param {(event: object) => void} [options.emit]    alias of onEvent
   */
  constructor({ onEvent = null, emit = null } = {}) {
    this.onEvent = onEvent || emit;
    this.reset();
  }

  reset() {
    this.state = 'stopped';
    this.minecraftVersion = null;
    this.neoforgeVersion = null;
    this.modCount = null;
    this.players = new Set();
    this.maxPlayers = null;
    this.tps = null;
    this.mspt = null;
    this.lastTickAt = 0;
    this.lastError = null;
    this.errors = [];
    this.done = false;
    this.doneAt = null;
    this.lagging = false;
  }

  /** Feed one raw line; returns the interpreted event (or null for empty lines). */
  feed(rawLine) {
    const event = interpret(rawLine);
    if (!event) return null;
    this.apply(event);
    // "line" (an ordinary, uninteresting output line) is not dispatched: the
    // console feed is handled by ConsoleService, the service only needs state.
    if (this.onEvent && event.type !== 'line') this.onEvent(event);
    return event;
  }

  apply(event) {
    switch (event.type) {
      case 'starting':
        this.state = 'starting';
        if (event.version) this.minecraftVersion = event.version;
        break;
      case 'version':
        if (event.neoforge) this.neoforgeVersion = event.neoforge;
        if (event.neoforgeVersion) this.neoforgeVersion = event.neoforgeVersion;
        if (event.modCount !== undefined && event.modCount !== null) this.modCount = event.modCount;
        break;
      case 'online':
        this.state = 'online';
        this.done = true;
        this.doneAt = Date.now();
        this.lastError = null;
        break;
      case 'list':
        this.maxPlayers = event.max ?? this.maxPlayers;
        this.players = new Set(event.players || []);
        break;
      case 'joined':
        this.players.add(event.player);
        break;
      case 'left':
        this.players.delete(event.player);
        break;
      case 'performance': {
        if (typeof event.mspt === 'number' && event.mspt > 0) {
          this.mspt = event.mspt;
          this.tps = Math.min(20, Math.round((1000 / event.mspt) * 10) / 10);
          this.lastTickAt = Date.now();
        } else if (typeof event.p50 === 'number' && event.p50 > 0) {
          this.mspt = event.p50;
          this.tps = Math.min(20, Math.round((1000 / event.p50) * 10) / 10);
          this.lastTickAt = Date.now();
        }
        break;
      }
      case 'tickrate':
        if (event.target && event.target > 0) this.targetTickRate = event.target;
        break;
      case 'lagging':
        this.lagging = true;
        break;
      case 'stopping':
        this.state = 'stopping';
        this.done = false;
        break;
      case 'error':
        this.lastError = event.error;
        this.errors.push({ at: new Date().toISOString(), ...event.error });
        if (this.errors.length > 50) this.errors.shift();
        break;
      default:
        break;
    }
  }

  snapshot() {
    return {
      state: this.state,
      minecraftVersion: this.minecraftVersion,
      neoforgeVersion: this.neoforgeVersion,
      modCount: this.modCount,
      players: [...this.players],
      maxPlayers: this.maxPlayers,
      tps: this.tps,
      mspt: this.mspt,
      lagging: this.lagging,
      lastError: this.lastError,
    };
  }
}

export default LogParser;
