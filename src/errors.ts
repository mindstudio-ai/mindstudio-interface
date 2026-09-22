/**
 * Error class for the @mindstudio-ai/interface SDK.
 *
 * Thrown by `createClient()` method calls on HTTP errors, by `platform`
 * actions on failures, and by the config reader when bootstrap globals
 * are missing.
 */
export class MindStudioInterfaceError extends Error {
  /** Machine-readable error code (e.g. 'method_not_found', 'not_initialized'). */
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

/**
 * The platform's error envelope, in one place.
 *
 * Every call site used to inline its own `{ error, code }` parse — a shape the
 * platform never sent. It answers `{ code: <numeric status>, errorString:
 * <slug>, errorMessage: <public text + request id>, error: <public text> }`, so
 * the old parse found no `error` (message stayed as the bare transport line,
 * "Auth request failed: 400") and read the NUMBER 400 into `code`, which made
 * every `err.code === 'invalid_code'` branch in app code unreachable.
 *
 * Message preference is `error` before `errorMessage`: they carry the same
 * public text, but `errorMessage` appends "| Request ID: …", which apps render
 * straight into the UI. Code preference is `errorString` before `code`, and
 * `code` only when it is a string — otherwise a numeric status would win again.
 * Older responses that really do send a string `{ error, code }` still parse.
 *
 * `fallbackMessage` is the transport line to keep when the body says nothing
 * useful; `fallbackCode` is the caller's domain slug (e.g. 'auth_error').
 */
export async function errorFromResponse(
  res: Response,
  fallbackMessage: string,
  fallbackCode: string,
): Promise<MindStudioInterfaceError> {
  let message = fallbackMessage;
  let code = fallbackCode;

  try {
    const body = (await res.json()) as {
      error?: string;
      errorMessage?: string;
      errorString?: string;
      code?: string | number;
    };
    if (typeof body.error === 'string' && body.error) {
      message = body.error;
    } else if (typeof body.errorMessage === 'string' && body.errorMessage) {
      message = body.errorMessage;
    }
    if (typeof body.errorString === 'string' && body.errorString) {
      code = body.errorString;
    } else if (typeof body.code === 'string' && body.code) {
      code = body.code;
    }
  } catch {
    // Response wasn't JSON — keep the fallbacks.
  }

  return new MindStudioInterfaceError(message, code, res.status);
}
