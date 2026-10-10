/**
 * Typed application errors.
 *
 * Every error carries a machine readable `code`, an HTTP status and an optional
 * `hint` that the UI shows to the user. Rule of this project: never surface a
 * bare "Error" - always explain what failed and what to do.
 */

export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 500, hint = '', details = null, cause = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      error: true,
      code: this.code,
      message: this.message,
      hint: this.hint || undefined,
      details: this.details || undefined,
    };
  }
}

export class ConfigError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'INVALID_CONFIGURATION', status: 400, ...opts });
  }
}

export class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'VALIDATION_ERROR', status: 400, ...opts });
  }
}

export class NotFoundError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'NOT_FOUND', status: 404, ...opts });
  }
}

export class ForbiddenError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'FORBIDDEN', status: 403, ...opts });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.', opts = {}) {
    super(message, { code: 'UNAUTHORIZED', status: 401, ...opts });
  }
}

export class ConflictError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'CONFLICT', status: 409, ...opts });
  }
}

export class RateLimitError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'RATE_LIMITED', status: 429, ...opts });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'SERVICE_UNAVAILABLE', status: 503, ...opts });
  }
}

/** Convert any thrown value into an AppError. */
export function toAppError(err) {
  if (err instanceof AppError) return err;
  const message = err?.message || String(err);
  const appErr = new AppError(message, { code: err?.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR', status: 500 });
  appErr.stack = err?.stack || appErr.stack;
  return appErr;
}

/**
 * Normalise a native fs error into a precise, user readable AppError.
 * "Error" alone is never acceptable - the UI must say what happened.
 */
export function fsError(err, target, action = 'access') {
  const path = target || err?.path || '';
  switch (err?.code) {
    case 'ENOENT':
      return new AppError(`File or directory not found: ${path}`, {
        code: 'FILE_NOT_FOUND', status: 404, hint: 'The file may have been moved or deleted.', cause: err,
      });
    case 'EACCES':
    case 'EPERM':
      return new AppError(`Permission denied while trying to ${action} ${path}`, {
        code: 'PERMISSION_DENIED', status: 403,
        hint: 'Close any program that locks the file, or run the panel with more rights.', cause: err,
      });
    case 'EISDIR':
      return new AppError(`${path} is a directory.`, { code: 'IS_A_DIRECTORY', status: 400, cause: err });
    case 'ENOTDIR':
      return new AppError(`${path} is not a directory.`, { code: 'NOT_A_DIRECTORY', status: 400, cause: err });
    case 'ENOSPC':
      return new AppError('Not enough disk space to complete the operation.', {
        code: 'NO_SPACE_LEFT', status: 507, hint: 'Free some space and retry.', cause: err,
      });
    case 'EBUSY':
      return new AppError(`${path} is locked by another process.`, {
        code: 'FILE_BUSY', status: 409, hint: 'Stop the Minecraft server and retry.', cause: err,
      });
    case 'EEXIST':
      return new AppError(`${path} already exists.`, { code: 'ALREADY_EXISTS', status: 409, cause: err });
    default:
      return new AppError(`Failed to ${action} ${path}: ${err?.message || 'unknown filesystem error'}`, {
        code: err?.code || 'FILE_ERROR', status: 500, cause: err,
      });
  }
}
