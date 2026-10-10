/**
 * HealthMonitor - the MSPT alert.
 *
 * The panel already receives the real tick times the server prints
 * ("tick query" / "average tick time" lines parsed by LogParser, see
 * MinecraftService 'performance' events). 50 ms per tick means 20 TPS, which
 * is a healthy server; 100 ms means the server is struggling at 10 TPS.
 *
 * This monitor turns those samples into a decision:
 *   - keep a short ring of samples with their timestamp;
 *   - when the median of the recent window stays above
 *     [monitor].mspt_alert_ms for [monitor].mspt_sustain_min minutes, raise an
 *     alert (SSE event + Discord notification + a log line);
 *   - when the median comes back under the threshold, publish the recovery;
 *   - never repeat an alert more often than [monitor].alert_cooldown_min.
 *
 * A single lag spike (a chunk generation, a backup) does not raise an alert:
 * the sustained window and the median are what make it actionable.
 */

import { EVENTS } from '../core/events.js';
import fs from 'node:fs/promises';
import path from 'node:path';

/** How many samples the monitor keeps. */
const RING_SIZE = 240;
/** Samples are taken by the Minecraft service every 3 s. */
const SAMPLE_INTERVAL_MS = 3000;
/** Ignore samples older than this when computing the median. */
const WINDOW_MS = 5 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const HISTORY_LIMIT = 30_000;

/** Median of a list of numbers (no dependency, no sorting surprises). */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

/** TPS implied by a millisecond-per-tick figure (capped at 20, like vanilla). */
export function tpsFromMspt(mspt) {
  if (!Number.isFinite(mspt) || mspt <= 0) return null;
  return Math.min(20, Math.round((1000 / mspt) * 10) / 10);
}

export class HealthMonitor {
  constructor({ config, logs, events = null, minecraft = null }) {
    this.config = config;
    this.logs = logs;
    this.log = logs?.application?.child('monitor');
    this.events = events;
    this.minecraft = minecraft;
    this.historyFile = path.join(config.paths.configDir, 'monitor-history.json');
    this.history = [];
    /** @type {{at:number, mspt:number, tps:number|null}[]} */
    this.samples = [];
    this.state = 'ok';            // ok | alerting | recovering
    this.since = null;            // when the sustained period started
    this.lastAlertAt = null;
    this.lastRecoveryAt = null;
    this.unsubscribe = null;
    this.persistTimer = null;
    this.persisting = false;
    this.ready = this.loadHistory();
  }

  get values() {
    return this.config.values.monitor;
  }

  start() {
    if (this.unsubscribe || !this.events) return;
    this.unsubscribe = this.events.subscribe(EVENTS.METRICS, (payload) => this.sample(payload));
    // A stopped server has no tick time: the samples of the previous run would
    // otherwise keep an alert alive across a restart.
    this.offStatus = this.events.subscribe(EVENTS.STATUS, (payload) => {
      if (payload?.state === 'stopped' || payload?.state === 'offline') this.reset({ reason: `server ${payload.state}` });
    });
    this.log?.info?.(`MSPT monitor armed (alert above ${this.values.mspt_alert_ms} ms per tick for ${this.values.mspt_sustain_min} minute(s)).`);
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.offStatus) this.offStatus();
    this.offStatus = null;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    void this.persistHistory();
  }

  /** Record one real metrics sample and re-evaluate the state. */
  sample(payload = {}) {
    // The Minecraft service publishes either `mspt` (from "tick query") or
    // `msptAvg` (from the periodic "average tick time" line).
    const raw = payload.mspt ?? payload.msptAvg;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    const at = payload.measuredAt ? Date.parse(payload.measuredAt) : Date.now();
    const entry = { at: Number.isFinite(at) ? at : Date.now(), mspt: value, tps: Number.isFinite(Number(payload.tps)) ? Number(payload.tps) : tpsFromMspt(value) };
    this.samples.push(entry);
    if (this.samples.length > RING_SIZE) this.samples.shift();
    this.history.push(entry);
    this.pruneHistory(entry.at);
    this.schedulePersist();
    this.evaluate(entry.at);
    return entry;
  }

  async loadHistory() {
    try {
      const info = await fs.stat(this.historyFile);
      if (info.size > 8 * 1024 * 1024) throw new Error('history file exceeds the 8 MiB safety limit');
      const parsed = JSON.parse(await fs.readFile(this.historyFile, 'utf8'));
      const now = Date.now();
      const loaded = (Array.isArray(parsed) ? parsed : []).filter((item) =>
        Number.isFinite(item?.at) && Number.isFinite(item?.mspt) && item.mspt > 0 && now - item.at <= HISTORY_MS,
      );
      // Metrics can arrive while the disk read is in progress; merge rather
      // than discarding those newer in-memory samples.
      this.history = [...loaded, ...this.history].sort((a, b) => a.at - b.at).slice(-HISTORY_LIMIT);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'ENOENT') this.log?.warn?.(`Could not load MSPT history: ${error.message}`);
    }
  }

  pruneHistory(now = Date.now()) {
    this.history = this.history.filter((item) => now - item.at <= HISTORY_MS).slice(-HISTORY_LIMIT);
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistHistory();
    }, 5000);
    this.persistTimer.unref?.();
  }

  async persistHistory() {
    if (this.persisting) return;
    this.persisting = true;
    try {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      const temporary = `${this.historyFile}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(this.history), 'utf8');
      await fs.rename(temporary, this.historyFile);
    } catch (error) {
      this.log?.warn?.(`Could not save MSPT history: ${error.message}`);
    } finally {
      this.persisting = false;
    }
  }

  historyWindow(durationMs, now = Date.now()) {
    const samples = this.history.filter((sample) => now - sample.at <= durationMs);
    return { samples: samples.length, mspt: median(samples.map((sample) => sample.mspt)), tps: median(samples.map((sample) => sample.tps).filter(Number.isFinite)) };
  }

  /** The samples of the recent window, used for the median. */
  window(now = Date.now()) {
    return this.samples.filter((sample) => now - sample.at <= WINDOW_MS);
  }

  /** Median MSPT of the recent window, or null when there is not enough data. */
  currentMspt(now = Date.now()) {
    const window = this.window(now);
    if (window.length < 3) return null;
    return median(window.map((sample) => sample.mspt));
  }

  /** Re-evaluate the alert state from the real samples. */
  evaluate(now = Date.now()) {
    const threshold = Number(this.values.mspt_alert_ms);
    const sustainMs = Number(this.values.mspt_sustain_min) * 60_000;
    const current = this.currentMspt(now);
    if (current === null) return this.state;

    if (current > threshold) {
      if (!this.since) {
        this.since = now;
        this.state = 'ok';
        return this.state;
      }
      if (now - this.since >= sustainMs) {
        const cooldownMs = Number(this.values.alert_cooldown_min) * 60_000;
        const cooled = !this.lastAlertAt || now - this.lastAlertAt >= cooldownMs;
        if (this.state !== 'alerting' || cooled) {
          this.lastAlertAt = now;
          this.state = 'alerting';
          this.raise(current, now);
        }
      }
      return this.state;
    }

    // Back under the threshold.
    this.since = null;
    if (this.state === 'alerting') {
      this.state = 'ok';
      this.lastRecoveryAt = now;
      this.recover(current, now);
    }
    return this.state;
  }

  raise(mspt, now = Date.now()) {
    const tps = tpsFromMspt(mspt);
    const players = this.minecraft?.playerList?.() || [];
    const message = `The server has been above ${this.values.mspt_alert_ms} ms per tick for ${this.values.mspt_sustain_min} minute(s) (now ${mspt} ms, about ${tps} TPS${players.length ? `, ${players.length} player(s) online` : ''}).`;
    this.log?.warn?.(`MSPT alert: ${message}`);
    this.publish({
      kind: 'performance',
      state: 'alerting',
      mspt,
      tps,
      players: players.length,
      threshold: Number(this.values.mspt_alert_ms),
      since: this.since,
      message,
      at: new Date(now).toISOString(),
    });
  }

  recover(mspt, now = Date.now()) {
    const tps = tpsFromMspt(mspt);
    const message = `The server is back to ${mspt} ms per tick (about ${tps} TPS), under the ${this.values.mspt_alert_ms} ms threshold.`;
    this.log?.info?.(`MSPT recovered: ${message}`);
    this.publish({
      kind: 'performance',
      state: 'recovered',
      mspt,
      tps,
      message,
      at: new Date(now).toISOString(),
    });
  }

  publish(payload) {
    this.events?.publish(EVENTS.MONITOR_ALERT, payload);
  }

  /** State for the API: real samples, no invented numbers. */
  status() {
    const current = this.currentMspt();
    return {
      enabled: true,
      thresholdMs: Number(this.values.mspt_alert_ms),
      sustainMin: Number(this.values.mspt_sustain_min),
      cooldownMin: Number(this.values.alert_cooldown_min),
      state: this.state,
      mspt: current,
      tps: tpsFromMspt(current),
      samples: this.samples.length,
      windowSamples: this.window().length,
      since: this.since ? new Date(this.since).toISOString() : null,
      lastAlertAt: this.lastAlertAt ? new Date(this.lastAlertAt).toISOString() : null,
      lastRecoveryAt: this.lastRecoveryAt ? new Date(this.lastRecoveryAt).toISOString() : null,
      serverRunning: this.minecraft?.isRunning?.() ?? false,
      recent: this.samples.slice(-12).map((sample) => ({ at: new Date(sample.at).toISOString(), mspt: sample.mspt, tps: sample.tps })),
      history: {
        fiveMinutes: this.historyWindow(5 * 60_000),
        oneHour: this.historyWindow(60 * 60_000),
        twentyFourHours: this.historyWindow(HISTORY_MS),
      },
    };
  }

  /**
   * Reset the state. Used when the server stops: a stopped server has no tick
   * time, and an alert must not linger across a restart.
   */
  reset({ reason = 'reset' } = {}) {
    this.samples = [];
    // Keep the cross-run history, but only reset the live alert window.
    this.since = null;
    this.state = 'ok';
    this.log?.debug?.(`Monitor reset (${reason}).`);
  }
}

export default HealthMonitor;
