/**
 * Structured API Error classes.
 *
 * Usage:
 *   throw new ValidationError('name is required');
 *   throw new NotFoundError('Document not found');
 *   throw new ConflictError('Dataset name already exists');
 *
 * The global error handler in server.js detects `instanceof ApiError`
 * and returns the structured JSON envelope automatically.
 */

export class ApiError extends Error {
  /**
   * @param {string} message  - Human-readable error description
   * @param {number} status   - HTTP status code
   * @param {string} code     - Machine-readable error code (e.g. 'VALIDATION_ERROR')
   * @param {*}      [details] - Optional additional details
   */
  constructor(message, status, code, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    const obj = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) obj.error.details = this.details;
    return obj;
  }
}

/**
 * 400 — request body / query param validation failure.
 * @param {string} message
 * @param {*} [details]
 */
export function ValidationError(message, details) {
  return new ApiError(message, 400, 'VALIDATION_ERROR', details);
}

/**
 * 404 — resource not found.
 * @param {string} message
 */
export function NotFoundError(message) {
  return new ApiError(message, 404, 'NOT_FOUND');
}

/**
 * 409 — resource conflict (duplicate name, etc.).
 * @param {string} message
 */
export function ConflictError(message) {
  return new ApiError(message, 409, 'CONFLICT');
}
