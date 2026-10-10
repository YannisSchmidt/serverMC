/**
 * Tiny persisted JSON document with debounced, atomic writes.
 * Used for the public page content, the panel state and player history.
 */

import { readJson, writeJson, ensureDir } from './fsx.js';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} file absolute path of the backing file
   * @param {object} defaults value returned when the file does not exist
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.loaded = false;
    this._timer = null;
    this._writing = Promise.resolve();
  }

  async load() {
    const raw = await readJson(this.file, null);
    if (raw && typeof raw === 'object') {
      this.data = { ...structuredClone(this.defaults), ...raw };
    } else {
      this.data = structuredClone(this.defaults);
      this.loaded = true;
      await this.flush();
      return this.data;
    }
    this.loaded = true;
    return this.data;
  }

  get(key, fallback = undefined) {
    if (key === undefined) return this.data;
    return this.data[key] === undefined ? fallback : this.data[key];
  }

  set(key, value) {
    if (typeof key === 'object' && key !== null) Object.assign(this.data, key);
    else this.data[key] = value;
    this.schedule();
    return this.data;
  }

  replace(value) {
    this.data = { ...structuredClone(this.defaults), ...value };
    this.schedule();
    return this.data;
  }

  schedule(delayMs = 150) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch(() => {});
    }, delayMs);
  }

  async flush() {
    await this._writing;
    const snapshot = JSON.stringify(this.data, null, 2) + '\n';
    this._writing = ensureDir(path.dirname(this.file)).then(() => writeJson(this.file, JSON.parse(snapshot)));
    await this._writing;
    return this.data;
  }
}
