/**
 * Service container.
 *
 * Services are registered as factories and resolved lazily, so the boot
 * sequence stays explicit and testable: the container can be built with a
 * throwaway configuration (see tests/) without touching the real machine.
 */

import { EventEmitter } from 'node:events';

export class Container extends EventEmitter {
  constructor(context = {}) {
    super();
    this.context = context;
    this.factories = new Map();
    this.instances = new Map();
    this.stopping = false;
  }

  /** Register a singleton factory. `name` is also the property used by `c.get()`. */
  register(name, factory) {
    if (typeof factory !== 'function') throw new TypeError(`Factory for "${name}" must be a function.`);
    this.factories.set(name, factory);
    return this;
  }

  has(name) {
    return this.factories.has(name) || this.instances.has(name);
  }

  /** Resolve (and memoise) a service. */
  get(name) {
    if (this.instances.has(name)) return this.instances.get(name);
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Service "${name}" is not registered.`);
    const instance = factory(this);
    this.instances.set(name, instance);
    return instance;
  }

  /** Register an already built instance (used by tests and the CLI). */
  provide(name, instance) {
    this.instances.set(name, instance);
    return this;
  }

  list() {
    return [...new Set([...this.factories.keys(), ...this.instances.keys()])];
  }

  /**
   * Resolve several services and call `start()` on those that define it,
   * in the given order. Failures are reported with the service name.
   */
  async startAll(names) {
    const started = [];
    for (const name of names) {
      const service = this.get(name);
      if (typeof service.start === 'function') {
        try {
          await service.start();
          started.push(name);
        } catch (err) {
          err.message = `Failed to start service "${name}": ${err.message}`;
          throw err;
        }
      }
    }
    this.startedServices = started;
    return started;
  }

  /**
   * Stop services in reverse order. Errors are collected, never thrown, so a
   * broken service cannot prevent the rest of the shutdown.
   */
  async stopAll(names = null) {
    this.stopping = true;
    const list = names || [...(this.startedServices || [])].reverse();
    const errors = [];
    for (const name of list) {
      const service = this.instances.get(name);
      if (!service || typeof service.stop !== 'function') continue;
      try {
        await service.stop();
      } catch (err) {
        errors.push({ service: name, error: err.message });
      }
    }
    return errors;
  }
}
