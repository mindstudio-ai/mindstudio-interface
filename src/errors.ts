/**
 * Error class for the @mindstudio-ai/interface SDK.
 *
 * Thrown by `createClient()` route calls on HTTP errors, by `platform`
 * actions on failures, and by the config reader when bootstrap globals
 * are missing.
 */
export class MindStudioInterfaceError extends Error {
  /** Machine-readable error code (e.g. 'route_not_found', 'not_initialized'). */
  readonly code: string;

  /** HTTP status code, when the error originated from an API response. */
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'MindStudioInterfaceError';
    this.code = code;
    this.status = status;
  }
}
