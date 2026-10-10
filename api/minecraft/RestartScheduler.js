/**
 * RestartScheduler - automatic restarts at fixed local times, with warnings.
 *
 * What it really does, every 15 seconds:
 *   1. look at the configured times ([restart].times, "HH:MM", local time);
 *   2. when a time passes and the server is running, warn the players with the
 *      vanilla `say` command at the configured marks ([restart].warn_minutes);
 *   3. optionally make a backup ([restart].auto_backup);
 *   4. restart the server through MinecraftService.restart(), which sends the
 *      `stop` command and waits for a clean exit.
 *
 * If the server is offline at the planned time, nothing happens and the next
 * occurrence is armed for tomorrow: a scheduled restart never starts a server
 * that the admin stopped on purpose.
 *
 * The schedule is deliberately wall-clock based and re-armed on configuration
 * changes, so a panel restart loses nothing.
 */

import { EVENTS } from '../core/events.js';
import { AppError } from '../util/errors.js';
import { mcQuote } from '../util/validate.js';

/** TICK of the scheduler: cheap, and precise enough for a minute-level plan. */
const CHECK_INTERVAL_MS = 15_000;
/** Never warn more than once per minute mark. */
const WARN_DEBOUNCE_MS = 60_000;
/**
 * How late a planned restart may still run. The scheduler checks every 15 s,
 * so a few seconds of lateness are normal; five minutes also covers a machine
 * that was asleep, while a slot that is hours old is skipped (the next
 * occurrence is armed for tomorrow instead of surprising the admin).
 */
const FIRE_GRACE_MS = 300_000;

/** "04:00" -> minutes since midnight, or null when invalid. */
export function parseTimeOfDay(raw) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Format minutes since midnight as "HH:MM". */
export function formatTimeOfDay(minutes) {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Minutes since midnight of a date, in the local timezone. */
export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * The next occurrence of a wall-clock time, strictly after `from`.
 * Returns a Date (local time).
 */
export function nextOccurrence(timeOfDay, from = new Date()) {
  const minutes = typeof timeOfDay === 'number' ? timeOfDay : parseTimeOfDay(timeOfDay);
  if (minutes === null) return null;
  const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, minutes, 0, 0);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/**
 * The occurrence of a time on the day of `now` - which may be in the past.
 * This is what the scheduler needs: a planned restart is armed when its time
 * has just passed, not on the next day.
 */
export function occurrenceOnDay(timeOfDay, now = new Date()) {
  const minutes = typeof timeOfDay === 'number' ? timeOfDay : parseTimeOfDay(timeOfDay);
  if (minutes === null) return null;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minutes, 0, 0);
}

/** Deduplicate and sort a list of times ("04:00", "4:00", 240). */
export function normalizeTimes(times) {
  const minutes = [];
  for (const raw of Array.isArray(times) ? times : [times]) {
    const parsed = parseTimeOfDay(raw);
    if (parsed !== null && !minutes.includes(parsed)) minutes.push(parsed);
  }
  return minutes.sort((a, b) => a - b);
}

/** The warning marks to use, sorted descending (10, 5, 1). */
export function normalizeWarnMinutes(warnMinutes) {
  const marks = (Array.isArray(warnMinutes) ? warnMinutes : [warnMinutes])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1440)
    .map((value) => Math.round(value));
  return [...new Set(marks)].sort((a, b) => b - a);
}

export class RestartScheduler {
  constructor({ config, logs, minecraft, backups = null, events = null }) {
    this.config = config;
    this.logs = logs;
    this.log = logs?.application?.child('restart');
    this.minecraft = minecraft;
    this.backups = backups;
    this.events = events;
    this.timer = null;
    /** armed[timeOfDay] = the timestamp of the last time it fired. */
    this.armed = new Map();
    /** warned[`${timeOfDay}:${minutes}`] = last warning timestamp. */
    this.warned = new Map();
    this.history = [];
    this.lastCheckAt = null;
    this.running = null;
  }

  get values() {
    return this.config.values.restart;
  }

  start() {
    if (this.timer) return;
    // A configuration change re-arms the schedule immediately: the panel must
    // never keep a plan that was just deleted from config/config.toml.
    this.offSettings = this.events?.subscribe?.(EVENTS.SETTINGS, () => this.tick());
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.tick();
    this.log?.info?.('Scheduled restarts armed' + (this.values.enabled ? ` (${this.values.times.join(', ')})` : ' (disabled in configuration)'));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.offSettings) this.offSettings();
    this.offSettings = null;
  }

  /** The planned restarts, soonest first, with the countdown. */
  plan(now = new Date()) {
    if (!this.values.enabled) return [];
    const out = [];
    for (const minutes of normalizeTimes(this.values.times)) {
      const at = nextOccurrence(minutes, now);
      if (at) out.push({ time: formatTimeOfDay(minutes), at: at.toISOString(), inMs: Math.max(0, at.getTime() - now.getTime()) });
    }
    return out;
  }

  /** State for the API and the banner. */
  status() {
    const now = new Date();
    const plan = this.plan(now);
    return {
      enabled: Boolean(this.values.enabled),
      times: normalizeTimes(this.values.times).map(formatTimeOfDay),
      warnMinutes: normalizeWarnMinutes(this.values.warn_minutes),
      autoBackup: Boolean(this.values.auto_backup),
      next: plan[0] || null,
      plan,
      lastCheckAt: this.lastCheckAt,
      running: this.running,
      history: this.history.slice(-10),
      serverRunning: this.minecraft?.isRunning?.() ?? false,
    };
  }

  /** Called by the scheduler and by the Settings page after a change. */
  tick(now = new Date()) {
    this.lastCheckAt = now.toISOString();
    if (!this.values.enabled) return;
    if (!this.minecraft?.isRunning?.()) {
      // Nothing to restart: the admin stopped the server on purpose.
      return;
    }
    const marks = normalizeWarnMinutes(this.values.warn_minutes);
    for (const minutes of normalizeTimes(this.values.times)) {
      const at = occurrenceOnDay(minutes, now);
      if (!at) continue;
      const msLeft = at.getTime() - now.getTime();
      // Warnings: only for the occurrence that is still in the future.
      for (const mark of marks) {
        if (mark <= 0) continue;
        const markMs = mark * 60_000;
        // Warn once, in the minute the countdown reaches the mark: the window
        // is one minute wide, so a check every 15 s can never miss it.
        if (msLeft > 0 && msLeft <= markMs && msLeft > markMs - 60_000) {
          const key = `${minutes}:${mark}`;
          const last = this.warned.get(key) || 0;
          if (now.getTime() - last > WARN_DEBOUNCE_MS) {
            this.warned.set(key, now.getTime());
            this.announce(`The server restarts in ${mark} minute(s) (scheduled maintenance at ${formatTimeOfDay(minutes)}).`);
          }
        }
      }
      // The planned time has just passed: restart.
      if (msLeft <= 0 && msLeft >= -FIRE_GRACE_MS) {
        const last = this.armed.get(minutes) || 0;
        if (now.getTime() - last > 60_000) {
          this.armed.set(minutes, now.getTime());
          // fire() records and publishes its own failure; the rejection is
          // handled here so a failed restart can never take the panel down.
          void this.fire(formatTimeOfDay(minutes)).catch((err) => {
            this.log?.error?.(`The scheduled restart failed: ${err.message}`);
          });
        }
      }
    }
  }

  /** Run the restart: backup (optional), warn, restart through the service. */
  async fire(timeLabel, { reason = 'scheduled restart' } = {}) {
    this.running = { at: new Date().toISOString(), time: timeLabel, state: 'running' };
    this.log?.info?.(`Scheduled restart (${timeLabel}) started.`);
    this.publish({ state: 'started', time: timeLabel });
    const record = { at: this.running.at, time: timeLabel, steps: [] };
    try {
      if (this.values.auto_backup && this.backups) {
        const backup = await this.backups.create({ label: `before scheduled restart ${timeLabel}`, reason: 'scheduled restart' }).catch((err) => {
          record.steps.push({ step: 'backup', ok: false, error: err.message });
          this.log?.warn?.(`The backup before the scheduled restart failed: ${err.message}`);
          return null;
        });
        if (backup) record.steps.push({ step: 'backup', ok: true, file: backup.name });
      }
      this.announce('The server is restarting now for scheduled maintenance.');
      const result = await this.minecraft.restart({ reason });
      record.steps.push({ step: 'restart', ok: true, result: Boolean(result) });
      record.state = 'done';
      this.history.push(record);
      this.publish({ state: 'done', time: timeLabel });
      return record;
    } catch (err) {
      record.state = 'failed';
      record.error = err.message;
      this.history.push(record);
      this.log?.error?.(`The scheduled restart failed: ${err.message}`);
      this.publish({ state: 'failed', time: timeLabel, error: err.message });
      throw err;
    } finally {
      this.running = null;
    }
  }

  /** Say something in the Minecraft chat (real command, real console). */
  announce(message) {
    if (!this.minecraft?.isRunning?.()) return false;
    try {
      this.minecraft.sendCommand(`say ${mcQuote(message)}`, { echo: false });
      return true;
    } catch (err) {
      this.log?.warn?.(`Could not warn the players (${err.message}).`);
      return false;
    }
  }

  publish(payload) {
    this.events?.publish(EVENTS.RESTART, { ...payload, at: new Date().toISOString() });
  }

  /**
   * Restart now, from the panel. Same path as a scheduled restart (backup,
   * warning, clean stop) so what the button does is exactly what the schedule
   * does at 4 AM.
   */
  async restartNow({ reason = 'manual (panel)' } = {}) {
    if (!this.minecraft?.isRunning?.()) {
      throw new AppError('The Minecraft server is not running, so there is nothing to restart.', {
        code: 'SERVER_NOT_RUNNING',
        status: 409,
        hint: 'Start the server first, or use the START button on the dashboard.',
      });
    }
    this.announce('The server is restarting now (requested from the panel).');
    return this.fire('now', { reason });
  }
}

export default RestartScheduler;
