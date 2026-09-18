/**
 * Error reporting — crashes batched and shipped to `/_/telemetry/errors`.
 *
 * ## Producers
 *
 * The window is not the design, it is one producer. Everything enters
 * through {@link capture}, and every entrant declares a MECHANISM (which
 * producer reported it) and whether it was HANDLED (did the app degrade
 * gracefully, or did the user hit a wall):
 *
 * | mechanism                      | source                        | handled |
 * | ------------------------------ | ----------------------------- | ------- |
 * | `browser.onerror`              | window `error` event          | false   |
 * | `browser.onunhandledrejection` | window rejection event        | false   |
 * | `react.error_handler`          | {@link reactErrorHandler}     | false   |
 * | `manual`                       | {@link captureException}      | true    |
 *
 * This matters because React never tells the window about an error one of
 * its boundaries caught — `onCaughtError` defaults to `console.error` and
 * nothing else — so a render crash in an app with a boundary is invisible
 * to the window listeners. React 19 apps wire the root hooks instead:
 *
 * ```ts
 * createRoot(el, {
 *   onUncaughtError: telemetry.reactErrorHandler(),
 *   onCaughtError: telemetry.reactErrorHandler(),
 * });
 * ```
 *
 * ## Transport
 *
 * Installed by `maybeInstallTelemetry()`, which `getConfig()` calls on
 * first successful bootstrap read — synchronously at import when the
 * platform bootstrap is present (see the eager-init block in
 * `src/index.ts`), because React's first render task would otherwise run
 * before the listeners existed. Falls back to lazy install on first SDK
 * use if eager init was skipped (SSR / tests / no bootstrap).
 *
 * 1. Producers enqueue into a pending batch (max 50 — the server cap).
 * 2. Events with the same fingerprint within a batch collapse into a
 *    single entry with `count: N` (bandwidth optimization).
 * 3. The batch flushes ~1s after the first push via `POST`.
 * 4. On `pagehide` / `visibilitychange='hidden'`, the buffer drains
 *    via `fetch` with `keepalive: true` so the Bearer header survives.
 * 5. On `429`, the SDK pauses sends for the `Retry-After` window.
 * 6. Any other transport failure is swallowed — telemetry must never
 *    crash the host app.
 *
 * Opt out of every producer, including the manual one, via
 * `window.__MINDSTUDIO__.telemetry = { errors: false }`.
 */

import { getConfig, withBase } from './config.js';
import {
  installBreadcrumbs,
  getBreadcrumbs,
  type Breadcrumb,
} from './telemetry-breadcrumbs.js';

const ENDPOINT = '/_/telemetry/errors';
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 50;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Which producer reported a crash. Server-side vocabulary; an unrecognized
 * string is stored as `unknown` rather than dropped.
 */
export type ErrorMechanism =
  | 'browser.onerror'
  | 'browser.onunhandledrejection'
  | 'react.error_handler'
  | 'manual';

interface ErrorEvent {
  releaseId: string;
  url: string;
  userAgent: string;
  timestamp: number;
  mechanism: string;
  handled: boolean;
  message: string;
  stack: string;
  componentStack?: string;
  source?: string;
  line?: number;
  column?: number;
  breadcrumbs: Breadcrumb[];
  count?: number;
  /** Internal: fingerprint for within-batch dedupe. Stripped before send. */
  _fp?: string;
}

let _installed = false;
let pending: ErrorEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let suppressUntil = 0;

function fingerprint(message: string, stack: string): string {
  const firstStackLine = stack.split('\n')[1] ?? '';
  return `${message}|${firstStackLine.trim()}`;
}

function enqueue(event: ErrorEvent): void {
  const fp = fingerprint(event.message, event.stack);

  for (const existing of pending) {
    if (existing._fp === fp) {
      existing.count = (existing.count ?? 1) + 1;
      return;
    }
  }

  if (pending.length >= MAX_BATCH_SIZE) {
    return;
  }

  event._fp = fp;
  pending.push(event);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer || pending.length === 0) {
    return;
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_INTERVAL_MS);
}

function takeBatch(): ErrorEvent[] {
  const batch = pending;
  pending = [];
  return batch.map(({ _fp, ...rest }) => {
    void _fp;
    return rest;
  });
}

async function flush(): Promise<void> {
  if (pending.length === 0) {
    return;
  }

  if (Date.now() < suppressUntil) {
    pending = [];
    return;
  }

  const config = (() => {
    try {
      return getConfig();
    } catch {
      return null;
    }
  })();
  if (!config) {
    pending = [];
    return;
  }

  const events = takeBatch();

  try {
    const res = await fetch(withBase(ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ events }),
    });

    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSec = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : NaN;
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : DEFAULT_RETRY_AFTER_MS;
      suppressUntil = Date.now() + waitMs;
    }
  } catch {
    // network / serialization failure — drop silently
  }
}

function drainOnUnload(): void {
  if (pending.length === 0) {
    return;
  }
  if (Date.now() < suppressUntil) {
    pending = [];
    return;
  }

  let config: ReturnType<typeof getConfig> | null = null;
  try {
    config = getConfig();
  } catch {
    pending = [];
    return;
  }

  const events = takeBatch();

  try {
    void fetch(withBase(ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({ events }),
      keepalive: true,
    });
  } catch {
    // best effort
  }
}

/**
 * Read a message + stack off anything a producer might hand us: an Error,
 * a rejection reason, a string, a DOM exception, `undefined`.
 */
function describe(
  error: unknown,
  fallbackMessage: string,
): { message: string; stack: string } {
  if (error instanceof Error) {
    return {
      message: error.message || fallbackMessage,
      stack: error.stack ?? '',
    };
  }
  if (error && typeof error === 'object') {
    const shaped = error as { message?: unknown; stack?: unknown };
    return {
      message:
        typeof shaped.message === 'string' && shaped.message
          ? shaped.message
          : String(error),
      stack: typeof shaped.stack === 'string' ? shaped.stack : '',
    };
  }
  return { message: String(error ?? fallbackMessage), stack: '' };
}

/**
 * The one door into the queue. Every producer goes through here, so the
 * errors opt-out, the bootstrap read and the never-throw guarantee are all
 * enforced in one place.
 */
function capture(
  error: unknown,
  options: {
    mechanism: string;
    handled: boolean;
    fallbackMessage?: string;
    /** Overrides for producers that know better than `error` does. */
    message?: string;
    componentStack?: string | null;
    source?: string;
    line?: number;
    column?: number;
  },
): void {
  try {
    const config = getConfig();
    if (config.telemetry?.errors === false) {
      return;
    }

    const described = describe(
      error,
      options.fallbackMessage ?? 'Unknown error',
    );

    enqueue({
      releaseId: config.releaseId,
      url: location.href,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      mechanism: options.mechanism,
      handled: options.handled,
      message: options.message || described.message,
      stack: described.stack,
      ...(options.componentStack
        ? { componentStack: options.componentStack }
        : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(typeof options.line === 'number' ? { line: options.line } : {}),
      ...(typeof options.column === 'number' ? { column: options.column } : {}),
      breadcrumbs: getBreadcrumbs(),
    });
  } catch {
    // never crash on capture
  }
}

function captureError(e: globalThis.ErrorEvent): void {
  capture(e.error, {
    mechanism: 'browser.onerror',
    handled: false,
    // The event's own message survives a cross-origin stack strip; the
    // error object may not be there at all.
    message: e.message,
    source: e.filename || undefined,
    line: typeof e.lineno === 'number' ? e.lineno : undefined,
    column: typeof e.colno === 'number' ? e.colno : undefined,
  });
}

function captureRejection(e: PromiseRejectionEvent): void {
  capture(e.reason, {
    mechanism: 'browser.onunhandledrejection',
    handled: false,
    fallbackMessage: 'Unhandled rejection',
  });
}

/**
 * Install error capture + breadcrumb collection. Idempotent.
 *
 * Reads `window.__MINDSTUDIO__.telemetry?.errors` — if explicitly
 * `false`, no listeners are attached and the function is a no-op.
 *
 * Otherwise attaches:
 * - `window.error` + `unhandledrejection`
 * - `pagehide` + `visibilitychange === 'hidden'` (for buffer drain)
 * - Breadcrumb sources via {@link installBreadcrumbs}
 */
export function installErrorMonitoring(): void {
  if (_installed) {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }

  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    return;
  }

  if (config.telemetry?.errors === false) {
    return;
  }

  _installed = true;

  installBreadcrumbs({
    captureResponseBodies: !!config.telemetryCaptureResponseBodies,
  });

  window.addEventListener('error', captureError);
  window.addEventListener('unhandledrejection', captureRejection);

  // Drain on the way out, but stay live: `pagehide` fires when a mobile
  // browser backgrounds the tab, and the page can come back from the
  // back/forward cache and run for hours more. Latching "unloaded" here
  // meant every crash after the first backgrounding was dropped.
  window.addEventListener('pagehide', drainOnUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      drainOnUnload();
    }
  });
}

/**
 * Wrapper that swallows any error from {@link installErrorMonitoring}
 * so a misbehaving telemetry layer can never break `getConfig()`.
 *
 * @internal Called from config.ts on every `getConfig()` — idempotency
 *   is enforced inside `installErrorMonitoring`.
 */
export function maybeInstallTelemetry(): void {
  try {
    installErrorMonitoring();
  } catch {
    // telemetry must never crash the host app
  }
}

//////////////////////////////////////////////////////////////////////////////
// Public API
//////////////////////////////////////////////////////////////////////////////

/** What React 19's `onCaughtError` / `onUncaughtError` pass as their 2nd arg. */
export interface ReactErrorInfo {
  componentStack?: string | null;
}

export interface CaptureOptions {
  /**
   * Which producer this came from. Defaults to `manual`. Values outside
   * {@link ErrorMechanism} are accepted but stored as `unknown`.
   */
  mechanism?: ErrorMechanism | string;
  /**
   * Did the app degrade gracefully? Defaults to `true` for a manual
   * capture — you caught it, so something other than a dead page happened.
   */
  handled?: boolean;
  /** React component tree, when you have one. */
  componentStack?: string | null;
}

export interface ReactErrorHandlerOptions {
  /**
   * Whether the boundary that caught this rendered a real fallback.
   * Defaults to `false`: a boundary existing is not evidence the app
   * recovered, and the common root boundary is a dead end.
   */
  handled?: boolean;
  /** Called after the report is queued, with React's own arguments. */
  onError?: (error: unknown, errorInfo?: ReactErrorInfo) => void;
}

export interface Telemetry {
  captureException(error: unknown, options?: CaptureOptions): void;
  reactErrorHandler(
    options?: ReactErrorHandlerOptions,
  ): (error: unknown, errorInfo?: ReactErrorInfo) => void;
}

/**
 * Crash reporting for cases the window can't see.
 *
 * @example Report something you caught yourself
 * ```ts
 * try {
 *   await api.submitOrder(order);
 * } catch (err) {
 *   telemetry.captureException(err);
 *   setError('Could not submit that order.');
 * }
 * ```
 *
 * @example Wire React 19's root hooks (required to see render crashes)
 * ```tsx
 * createRoot(document.getElementById('root')!, {
 *   onUncaughtError: telemetry.reactErrorHandler(),
 *   onCaughtError: telemetry.reactErrorHandler(),
 * }).render(<App />);
 * ```
 */
export const telemetry: Telemetry = {
  captureException(error, options) {
    capture(error, {
      mechanism: options?.mechanism ?? 'manual',
      handled: options?.handled ?? true,
      ...(options?.componentStack
        ? { componentStack: options.componentStack }
        : {}),
    });
  },

  reactErrorHandler(options) {
    return (error, errorInfo) => {
      capture(error, {
        mechanism: 'react.error_handler',
        handled: options?.handled ?? false,
        ...(errorInfo?.componentStack
          ? { componentStack: errorInfo.componentStack }
          : {}),
      });
      options?.onError?.(error, errorInfo);
    };
  },
};
