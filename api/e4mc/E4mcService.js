/**
 * E4mcService - public Minecraft address through the e4mc relay network.
 *
 * Why a tool and not a mod: e4mc (https://e4mc.link) is a *singleplayer/LAN* mod
 * ("Open to LAN" button) - it can not be loaded by a dedicated server. The e4mc
 * developer publishes the standalone relay client "e4mcbiat" which speaks the
 * exact same protocol (broker.e4mc.link getBestRelay -> QUIC "quiclime" control
 * stream -> domain_assignment_complete -> xxxx.e4mc.link) and tunnels incoming
 * player connections to localhost:<port>.
 *
 * This service runs that official client with its documented CLI
 * (`java -jar e4mcbiat-x.y.z-all.jar nogui port=25565`), reads the assigned
 * domain from its stdout ("Connected, domain: ...") and exposes it to the panel.
 * Nothing is simulated: if the relay cannot be reached, the status says so and
 * a manual address can be configured as a documented fallback.
 *
 * e4mc is a Minecraft transport. Cloudflare is NEVER involved here.
 */

import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawnProcess, terminateProcess, stdinIsGone } from '../util/proc.js';
import { AppError, ServiceUnavailableError } from '../util/errors.js';
import { pathExists, statOrNull, humanBytes } from '../util/fsx.js';
import { fetchJson } from '../util/net.js';
import { redactString } from '../util/redact.js';
import { HOSTNAME_RE } from '../util/validate.js';

export const BROKER_URL = 'https://broker.e4mc.link/getBestRelay';

/**
 * Parse one line of the official relay client output.
 * Verified against e4mcbiat's Main.java:
 *   onDomainAssigned -> "Connected, domain: " + domain
 *   onBroadcast      -> "e4mc broadcast: " + message
 * Returns { domain, broadcast, error } - all optional.
 */
export function parseRelayLine(line) {
  const text = String(line || '').trim();
  if (!text) return {};
  const domain = /domain:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})/i.exec(text);
  if (domain) return { domain: domain[1] };
  const broadcast = /e4mc broadcast:\s*(.+)$/i.exec(text);
  if (broadcast) return { broadcast: broadcast[1].trim() };
  if (/Failed to get best relay/i.test(text)) {
    return {
      error: {
        code: 'E4MC_BROKER_UNREACHABLE',
        message: 'The e4mc broker could not be reached (broker.e4mc.link).',
        hint: 'Check your internet connection, DNS, VPN or firewall. The Minecraft server keeps working locally.',
        detail: text,
      },
    };
  }
  if (/Control stream closed abruptly|Connection refused|UnknownHostException|IOException/i.test(text)) {
    return {
      error: {
        code: 'E4MC_RELAY_UNREACHABLE',
        message: 'The e4mc relay connection was lost.',
        hint: 'The relay may be restarting. The panel retries automatically; the Minecraft server keeps working locally.',
        detail: text,
      },
    };
  }
  if (/^Exception|\bat tech\.kwik|java\.lang\./i.test(text)) {
    return {
      error: {
        code: 'E4MC_CLIENT_ERROR',
        message: `The e4mc relay client reported an error: ${text.slice(0, 200)}`,
        hint: 'Check that the e4mcbiat jar is the official release and that Java 11+ is used.',
        detail: text,
      },
    };
  }
  return {};
}

export const E4MC_STATES = {
  DISABLED: 'disabled',
  MISSING: 'missing',
  STOPPED: 'stopped',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  MANUAL: 'manual',
  ERROR: 'error',
};

export class E4mcService {
  constructor({ config, logs, minecraft, events, java, install }) {
    this.config = config;
    this.log = logs.e4mc;
    this.minecraft = minecraft;
    this.events = events;
    this.java = java;
    this.install = install;

    this.state = config.values.e4mc.enabled ? E4MC_STATES.STOPPED : E4MC_STATES.DISABLED;
    this.child = null;
    this.address = null;
    this.addressSource = null; // 'relay' | 'manual'
    this.assignedAt = null;
    this.lastCheckAt = null;
    this.lastLatencyMs = null;
    this.error = null;
    this.restartAttempts = 0;
    this.output = [];
  }

  // -------------------------------------------------------------- lifecycle

  get jarPath() {
    return this.config.paths.e4mcJar;
  }

  get targetPort() {
    return this.config.e4mcPort;
  }

  isRunning() {
    return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start() {
    if (!this.config.values.e4mc.enabled) {
      this.setState(E4MC_STATES.DISABLED, { reason: 'e4mc disabled in configuration' });
      return this.status();
    }
    const manual = this.config.values.e4mc.manual_address;
    if (manual) {
      this.address = manual;
      this.addressSource = 'manual';
    }
    if (this.config.values.e4mc.autostart_with_server && this.minecraft) {
      // Start the relay whenever the server becomes reachable.
      this.minecraft.on('state', ({ state }) => {
        if (state === 'online' && this.config.values.e4mc.enabled && !this.isRunning()) {
          this.startRelay({ reason: 'server online' }).catch((err) => this.log.error(`e4mc relay start failed: ${err.message}`));
        }
        if ((state === 'stopped' || state === 'error') && this.isRunning()) {
          this.stopRelay({ reason: `minecraft ${state}` }).catch(() => {});
        }
      });
    }
    if (this.minecraft?.state === 'online') await this.startRelay({ reason: 'panel boot (server already running)' });
    return this.status();
  }

  async stop() {
    await this.stopRelay({ reason: 'panel shutdown' }).catch((err) => this.log.warn(`e4mc shutdown: ${err.message}`));
  }

  setState(state, { reason = null, error = null } = {}) {
    const previous = this.state;
    this.state = state;
    if (error !== null) this.error = error;
    this.events?.publish('e4mc', { state, previous, reason, address: this.address, addressSource: this.addressSource, error: error || undefined, at: new Date().toISOString(), snapshot: this.status() });
    if (previous !== state) this.log.info(`e4mc state: ${previous} -> ${state}${reason ? ` (${reason})` : ''}`);
  }

  /** Launch the official relay client. */
  async startRelay({ reason = 'manual', restart = false } = {}) {
    if (!this.config.values.e4mc.enabled) throw new AppError('e4mc is disabled in the configuration.', { code: 'E4MC_DISABLED', status: 409, hint: 'Enable [e4mc].enabled in the Settings page.' });
    if (this.isRunning()) return { alreadyRunning: true, status: this.status() };

    if (!(await pathExists(this.jarPath))) {
      if (this.config.values.e4mc.auto_download && this.install) {
        this.setState(E4MC_STATES.MISSING, { reason: 'relay jar missing, downloading' });
        try {
          await this.install.downloadE4mcRelay({});
        } catch (err) {
          this.setState(E4MC_STATES.MISSING, { error: { code: 'E4MC_JAR_MISSING', message: `The e4mc relay client is missing: ${err.message}`, hint: 'Download e4mcbiat from https://github.com/DuncanRuns/e4mcbiat/releases and place it in minecraft/launcher/e4mcbiat.jar, or disable [e4mc].auto_download to manage it yourself.' } });
          throw new AppError('The e4mc relay client (e4mcbiat.jar) was not found and could not be downloaded.', {
            code: 'E4MC_JAR_MISSING', status: 503,
            hint: 'Place the official e4mcbiat jar in minecraft/launcher/e4mcbiat.jar (see README, section e4mc).',
          });
        }
      } else {
        this.setState(E4MC_STATES.MISSING, { error: { code: 'E4MC_JAR_MISSING', message: 'The e4mc relay client (e4mcbiat.jar) is not installed.', hint: `Expected at ${this.jarPath}. Download it from https://github.com/DuncanRuns/e4mcbiat/releases.` } });
        throw new AppError('The e4mc relay client (e4mcbiat.jar) is not installed.', {
          code: 'E4MC_JAR_MISSING', status: 503,
          hint: `Download e4mcbiat from https://github.com/DuncanRuns/e4mcbiat/releases and save it as ${this.jarPath}.`,
        });
      }
    }

    const java = await this.java.requireUsable().catch((err) => {
      this.setState(E4MC_STATES.ERROR, { error: { code: 'E4MC_JAVA_MISSING', message: err.message, hint: err.hint } });
      throw err;
    });

    // The relay client needs the Minecraft port to forward players to.
    const port = this.targetPort;
    const args = ['-jar', this.jarPath, 'nogui', `port=${port}`];
    this.setState(E4MC_STATES.CONNECTING, { reason: `${reason} (relay port ${port})` });
    this.log.info(`Starting the official e4mc relay client (${path.basename(this.jarPath)}) on port ${port}...`);
    this.output = [];

    let child;
    try {
      child = spawnProcess(java.path, args, { cwd: path.dirname(this.jarPath) });
    } catch (err) {
      this.setState(E4MC_STATES.ERROR, { error: { code: 'E4MC_SPAWN_FAILED', message: err.message } });
      throw err;
    }
    this.child = child;
    this.error = null;
    this.assignedAt = null;

    const handleLine = (line, stream) => {
      const text = redactString(line.trim());
      if (!text) return;
      this.output.push({ at: new Date().toISOString(), stream, text });
      if (this.output.length > 200) this.output.shift();
      this.log.info(text);
      // e4mcbiat prints: "Connected, domain: xxxx.e4mc.link"
      const parsed = parseRelayLine(text);
      if (parsed.domain) {
        this.address = parsed.domain;
        this.addressSource = 'relay';
        this.assignedAt = new Date().toISOString();
        this.restartAttempts = 0;
        this.setState(E4MC_STATES.ONLINE, { reason: 'relay assigned a domain' });
        this.log.info(`e4mc public address: ${this.address}`);
      }
      if (parsed.error) this.error = parsed.error;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach((l) => handleLine(l, 'stdout'));
    });
    child.stderr.on('data', (chunk) => String(chunk).split(/\r?\n/).forEach((l) => l.trim() && handleLine(l, 'stderr')));
    child.on('error', (err) => {
      this.setState(E4MC_STATES.ERROR, { error: { code: 'E4MC_PROCESS_ERROR', message: err.message } });
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));

    // Connection timeout watchdog
    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (this.state === E4MC_STATES.CONNECTING && this.isRunning()) {
        this.error = {
          code: 'E4MC_TIMEOUT',
          message: `e4mc did not assign a public address within ${this.config.values.e4mc.connect_timeout_s} seconds.`,
          hint: 'The e4mc relay may be busy or blocked by a firewall/VPN. The Minecraft server itself is unaffected; you can also set [e4mc].manual_address.',
        };
        this.setState(E4MC_STATES.ERROR, { reason: 'domain assignment timeout' });
      }
    }, this.config.values.e4mc.connect_timeout_s * 1000);

    return { started: true, pid: child.pid, status: this.status() };
  }

  async stopRelay({ reason = 'manual stop' } = {}) {
    if (!this.isRunning()) {
      if (this.state !== E4MC_STATES.DISABLED && this.state !== E4MC_STATES.MISSING) this.setState(E4MC_STATES.STOPPED, { reason });
      return { stopped: true, alreadyStopped: true };
    }
    this._stopRequested = true;
    clearTimeout(this._connectTimer);
    this.log.info(`Stopping the e4mc relay client (${reason})...`);
    try {
      // e4mcbiat reads "stop" on stdin for a clean shutdown. The callback matters: an
      // EPIPE delivered as a stream 'error' event would be an uncaught exception, and a
      // relay that is already closing is not an error - it is the outcome we asked for.
      if (this.child.stdin && !stdinIsGone(this.child)) {
        this.child.stdin.write('stop\n', (err) => {
          if (err) this.log.info(`The e4mc relay closed before "stop" was read (${err.code || err.message}).`);
        });
      }
    } catch {
      /* the relay is gone already: the exit race below decides whether that is fine */
    }
    const graceful = await Promise.race([
      new Promise((resolve) => this.child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 6000)),
    ]);
    if (!graceful) await terminateProcess(this.child, { graceMs: 5000 });
    this.child = null;
    this._stopRequested = false;
    this.setState(E4MC_STATES.STOPPED, { reason });
    return { stopped: true, graceful };
  }

  async onExit(code, signal) {
    clearTimeout(this._connectTimer);
    const wasOnline = this.state === E4MC_STATES.ONLINE;
    this.child = null;
    if (this._stopRequested) return;
    this.log.warn(`e4mc relay client exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).`);
    const shouldRestart = this.config.values.e4mc.enabled
      && this.minecraft?.state === 'online'
      && !this._stopping
      && this.restartAttempts < 3;
    if (!shouldRestart) {
      const diagnosis = this.error || {
        code: 'E4MC_STOPPED',
        message: wasOnline ? 'The e4mc relay connection was lost.' : 'The e4mc relay client stopped.',
        hint: 'Start it again from the dashboard. The Minecraft server keeps running locally.',
      };
      this.setState(E4MC_STATES.ERROR, { reason: 'relay exited', error: { ...diagnosis, at: new Date().toISOString() } });
      return;
    }
    this.restartAttempts += 1;
    const delay = 2000 * this.restartAttempts;
    this.log.warn(`Restarting the e4mc relay in ${delay / 1000}s (attempt ${this.restartAttempts}/3)...`);
    this.setState(E4MC_STATES.CONNECTING, { reason: `automatic restart ${this.restartAttempts}/3` });
    setTimeout(() => {
      this.startRelay({ reason: 'automatic restart', restart: true }).catch((err) => {
        this.setState(E4MC_STATES.ERROR, { error: { code: 'E4MC_RESTART_FAILED', message: err.message, hint: err.hint } });
      });
    }, delay);
  }

  // ------------------------------------------------------------------ checks

  /** Pre-flight for `doctor`: is the e4mc broker reachable? */
  async checkBroker({ timeoutMs = 8000 } = {}) {
    const started = Date.now();
    try {
      const relay = await fetchJson(BROKER_URL, { timeoutMs, maxBytes: 64 * 1024 });
      return {
        ok: Boolean(relay?.host),
        ms: Date.now() - started,
        relay: relay?.host ? { host: relay.host, port: relay.port, id: relay.id } : null,
      };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: err.message, hint: 'The relay network may be down (check status.e4mc.link) or your network blocks it.' };
    }
  }

  /**
   * Verify the published address: DNS resolution + TCP connection to the relay
   * on the Minecraft port. This tests the real path a player will use.
   */
  async testAddress(address = this.address) {
    const host = String(address || '').replace(/^https?:\/\//, '').split(':')[0];
    this.lastCheckAt = new Date().toISOString();
    if (!host) {
      throw new AppError('No e4mc address to test yet.', { code: 'NO_ADDRESS', status: 409, hint: 'Wait for the relay to assign a domain, or set a manual address.' });
    }
    if (!HOSTNAME_RE.test(host)) throw new AppError(`"${address}" is not a valid domain name.`, { code: 'VALIDATION_ERROR', status: 400 });

    const result = { host, checkedAt: this.lastCheckAt, dns: { ok: false, addresses: [] }, tcp: { ok: false, ms: null } };
    try {
      const addresses = await dns.lookup(host, { all: true, verbatim: true });
      result.dns = { ok: addresses.length > 0, addresses: addresses.map((a) => a.address) };
    } catch (err) {
      result.dns = { ok: false, addresses: [], error: err.message };
    }
    if (result.dns.ok) {
      const started = Date.now();
      result.tcp = await new Promise((resolve) => {
        const socket = net.connect({ host, port: 25565 });
        const done = (ok, error) => {
          socket.destroy();
          resolve({ ok, ms: Date.now() - started, error });
        };
        socket.setTimeout(6000);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false, 'Connection timed out'));
        socket.once('error', (err) => done(false, err.message));
      });
      this.lastLatencyMs = result.tcp.ms;
    }
    // A successful TCP connection proves the tunnel is up end to end.
    if (result.tcp.ok && this.state === E4MC_STATES.ERROR) this.setState(E4MC_STATES.ONLINE, { reason: 'address reachable' });
    this.events?.publish('e4mc', { state: this.state, test: result, address: this.address, snapshot: this.status() });
    return result;
  }

  /** Persist a manual address (used when automatic detection is impossible). */
  async setManualAddress(address) {
    const value = String(address || '').trim();
    if (value && !HOSTNAME_RE.test(value.replace(/:\d+$/, ''))) {
      throw new AppError(`"${value}" is not a valid address.`, { code: 'VALIDATION_ERROR', status: 400, hint: 'Example: myworld.e4mc.link' });
    }
    await this.config.update({ e4mc: { manual_address: value } });
    if (value && !this.address) {
      this.address = value;
      this.addressSource = 'manual';
      this.setState(E4MC_STATES.MANUAL, { reason: 'manual address configured' });
    }
    if (!value && this.addressSource === 'manual') {
      this.address = null;
      this.addressSource = null;
      this.setState(this.isRunning() ? E4MC_STATES.CONNECTING : E4MC_STATES.STOPPED, { reason: 'manual address cleared' });
    }
    return this.status();
  }

  async setEnabled(enabled) {
    await this.config.update({ e4mc: { enabled: Boolean(enabled) } });
    if (!enabled) {
      this._stopping = true;
      await this.stopRelay({ reason: 'e4mc disabled' }).catch(() => {});
      this._stopping = false;
      this.setState(E4MC_STATES.DISABLED, { reason: 'disabled in settings' });
    } else {
      this.setState(this.isRunning() ? this.state : E4MC_STATES.STOPPED, { reason: 'enabled in settings' });
      if (this.minecraft?.state === 'online') await this.startRelay({ reason: 'enabled in settings' });
    }
    return this.status();
  }

  // ------------------------------------------------------------------ status

  async runtimeStatus() {
    const jarStat = await statOrNull(this.jarPath);
    return {
      enabled: this.config.values.e4mc.enabled,
      state: this.state,
      online: this.state === E4MC_STATES.ONLINE,
      address: this.address,
      addressSource: this.addressSource,
      port: this.targetPort,
      publicPort: 25565,
      assignedAt: this.assignedAt,
      lastCheckAt: this.lastCheckAt,
      lastLatencyMs: this.lastLatencyMs,
      lastUpdate: this.assignedAt || this.output.at(-1)?.at || null,
      error: this.error,
      pid: this.child?.pid ?? null,
      restartAttempts: this.restartAttempts,
      jar: {
        path: this.config.paths.e4mcJar,
        relativePath: path.relative(this.config.paths.projectRoot, this.config.paths.e4mcJar),
        present: Boolean(jarStat),
        size: jarStat?.size ?? null,
        sizeHuman: jarStat?.size ? humanBytes(jarStat.size) : null,
      },
      manualAddress: this.config.values.e4mc.manual_address || null,
      autostart: this.config.values.e4mc.autostart_with_server,
      client: 'e4mcbiat (official e4mc relay client)',
      broker: BROKER_URL,
      tail: this.output.slice(-12),
      explanation: 'e4mc tunnels Minecraft traffic to localhost. Cloudflare is never used for Minecraft connections.',
    };
  }

  status() {
    return {
      enabled: this.config.values.e4mc.enabled,
      state: this.state,
      online: this.state === E4MC_STATES.ONLINE,
      address: this.address,
      addressSource: this.addressSource,
      port: this.targetPort,
      lastCheckAt: this.lastCheckAt,
      assignedAt: this.assignedAt,
      error: this.error,
      jarPresent: null,
    };
  }
}

export { ServiceUnavailableError };
