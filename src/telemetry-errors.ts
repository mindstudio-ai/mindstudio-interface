/**
 * Error reporting — auto-capture of uncaught errors and unhandled
 * promise rejections, batched and shipped to `/_/telemetry/errors`.
 *
 * ## How it works
 *
 * Installed by `maybeInstallTelemetry()` in `config.ts` on the first
 * `getConfig()` call. Once installed:
 *
 * 1. `window.error` and `unhandledrejection` listeners enqueue events
 *    into a pending batch (max 50 per batch — the server cap).
 * 2. Events with the same fingerprint within a batch collapse into a
 *    single entry with `count: N` (bandwidth optimization).
 * 3. The batch flushes ~1s after the first push via `POST` to
 *    `/_/telemetry/errors`.
 * 4. On `pagehide` / `visibilitychange='hidden'`, the buffer drains
 *    via `fetch` with `keepalive: true` so the Bearer header survives.
 * 5. On `429`, the SDK pauses sends for the `Retry-After` window.
 * 6. Any other transport failure is swallowed — telemetry must never
 *    crash the host app.
 *
 * No public API — the only knob is opt-out via
 * `window.__MINDSTUDIO__.telemetry = { errors: false }`.
 */

import { getConfig } from './config.js';
import {
  installBreadcrumbs,
  getBreadcrumbs,
  type Breadcrumb,
} from './telemetry-breadcrumbs.js';

const ENDPOINT = '/_/telemetry/errors';
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 50;
const DEFAULT_RETRY_AFTER_MS = 60_000;

interface ErrorEvent {
  releaseId: string;
  url: string;
  userAgent: string;
  timestamp: number;
  type: 'error' | 'unhandledrejection';
  message: string;
  stack: string;
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
let unloaded = false;

function fingerprint(message: string, stack: string): string {
  const firstStackLine = stack.split('\n')[1] ?? '';
  return `${message}|${firstStackLine.trim()}`;
}

function enqueue(event: ErrorEvent): void {
  if (unloaded) {
    return;
  }

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
    const res = await fetch(ENDPOINT, {
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
    void fetch(ENDPOINT, {
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

function captureError(e: globalThis.ErrorEvent): void {
  try {
    const config = getConfig();
    enqueue({
      releaseId: config.releaseId,
      url: location.href,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      type: 'error',
      message: e.message || 'Unknown error',
      stack: e.error?.stack ?? '',
      source: e.filename || undefined,
      line: typeof e.lineno === 'number' ? e.lineno : undefined,
      column: typeof e.colno === 'number' ? e.colno : undefined,
      breadcrumbs: getBreadcrumbs(),
    });
  } catch {
    // never crash on capture
  }
}

function captureRejection(e: PromiseRejectionEvent): void {
  try {
    const config = getConfig();
    const reason = e.reason as
      | { message?: string; stack?: string }
      | string
      | undefined;

    let message: string;
    let stack = '';

    if (reason && typeof reason === 'object') {
      message = reason.message || String(reason);
      stack = reason.stack ?? '';
    } else {
      message = String(reason ?? 'Unhandled rejection');
    }

    enqueue({
      releaseId: config.releaseId,
      url: location.href,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      type: 'unhandledrejection',
      message,
      stack,
      breadcrumbs: getBreadcrumbs(),
    });
  } catch {
    // never crash on capture
  }
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

  const handleUnload = (): void => {
    unloaded = true;
    drainOnUnload();
  };
  window.addEventListener('pagehide', handleUnload);
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
