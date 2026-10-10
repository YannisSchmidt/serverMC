/** Minimal dependency-free router (method + path pattern with :params). */

export function matchPattern(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const part = patternParts[i];
    if (part === '*') {
      params.rest = pathParts.slice(i).join('/');
      return params;
    }
    if (i >= pathParts.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i]);
      continue;
    }
    if (part !== pathParts[i]) return null;
  }
  if (pathParts.length !== patternParts.length) return null;
  return params;
}

export class Router {
  constructor(prefix = '') {
    this.routes = [];
    this.prefix = prefix;
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({ method, pattern: `${this.prefix}${pattern}`, handler, options });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }

  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }

  put(pattern, handler, options) {
    return this.add('PUT', pattern, handler, options);
  }

  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }

  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  /**
   * Find a handler.
   * @returns {{route, params}|null}
   */
  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPattern(route.pattern, pathname);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  /** Human readable route list (used by the API index endpoint). */
  describe() {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }
}

export function createRouter(prefix = '') {
  return new Router(prefix);
}
