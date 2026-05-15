/**
 * Analytics — Plausible/Fathom-style visitor analytics.
 *
 * Auto-tracks pageviews via the existing history patches in
 * `telemetry-breadcrumbs.ts` and exposes a small public API:
 *
 * ```ts
 * import { analytics } from '@mindstudio-ai/interface';
 *
 * // Custom events (optional — pageviews track automatically)
 * analytics.track('vendor_submitted', { vendorType: 'restaurant' });
 * ```
 *
 * Server-side derivation handles geo (IP → country), device class
 * (UA → mobile/tablet/desktop), referrers, UTM parsing, and
 * sessionization. The SDK ships nothing for those — just raw
 * pageview events with enough context for backend enrichment.
 *
 * ## How it works
 *
 * Installed by `maybeInstallAnalytics()`, which is called by `getConfig()`
 * in `config.ts`. `getConfig()` runs automatically on the next tick after
 * SDK import when the platform bootstrap is present (see eager-init block
 * in `src/index.ts`), so pageview tracking + presence are live at page
 * load without app code needing to invoke anything. Falls back to lazy
 * install on first SDK use if eager init was skipped.
 *
 * Once installed:
 *
 * 1. Subscribes to navigation events from `telemetry-breadcrumbs.ts`
 *    and emits a pageview on each change.
 * 2. Fires an initial pageview for the first-load URL.
 * 3. Batches events (~1s debounce, 100/batch cap) and POSTs to
 *    `/_/telemetry/events`.
 * 4. On `pagehide` / `visibilitychange='hidden'`, drains via
 *    `fetch` with `keepalive: true`.
 * 5. On `429`, pauses sends for the `Retry-After` window.
 *
 * ## Privacy posture
 *
 * Live visitor counts are intentionally **not** exposed to app code.
 * Aggregate visitor metrics (live count included) are surfaced only
 * through the platform dashboard to the app owner — visitors should
 * not be able to learn about other visitors' presence through the
 * SDK. If an app explicitly wants user-facing presence as a designed
 * feature (e.g. a multiplayer experience), it must build that on its
 * own application-level abstraction with its own consent semantics,
 * not on platform telemetry.
 *
 * Opt-out via `window.__MINDSTUDIO__.telemetry = { analytics: false }`.
 */

import { getConfig } from './config.js';
import { onNavigation } from './telemetry-breadcrumbs.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Flat-primitive prop values for custom events.
 *
 * Backend caps: max 10 keys, key length ~50 chars, value length ~500 chars.
 * Non-primitive values (objects, arrays, null) are stripped client-side
 * before send to save bandwidth — backend would silently drop them anyway.
 */
export type CustomEventProps = Record<string, string | number | boolean>;

/**
 * The analytics namespace — pageview auto-tracking + custom events.
 *
 * Pageviews are auto-tracked from history changes; no public API for
 * them. Opt out entirely via `window.__MINDSTUDIO__.telemetry.analytics = false`.
 */
export interface AnalyticsClient {
  /**
   * Record a custom event with optional flat-primitive props.
   *
   * Non-primitive prop values (objects, arrays, null, undefined) are
   * stripped client-side before send. Server further caps name length
   * to 200 chars, props to 10 keys, key length to 50, value length to 500.
   *
   * Best-effort — never throws, never blocks. If the SDK isn't
   * initialized yet, the call is silently dropped.
   */
  track(event: string, props?: CustomEventProps): void;
}

// ---------------------------------------------------------------------------
// Internal event types
// ---------------------------------------------------------------------------

type PageviewEvent = {
  type: 'pageview';
  releaseId: string;
  url: string;
  referrer: string;
  userAgent: string;
  language: string;
  screen: { w: number; h: number };
  timestamp: number;
};

type CustomEvent = {
  type: 'event';
  releaseId: string;
  name: string;
  url: string;
  timestamp: number;
  props?: CustomEventProps;
};

type AnalyticsEvent = PageviewEvent | CustomEvent;

// ---------------------------------------------------------------------------
// Batched event transport
// ---------------------------------------------------------------------------

const EVENTS_ENDPOINT = '/_/telemetry/events';
const FLUSH_INTERVAL_MS = 1000;
const MAX_BATCH_SIZE = 100;
const DEFAULT_RETRY_AFTER_MS = 60_000;

let pending: AnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let suppressUntil = 0;
let unloaded = false;

function enqueue(event: AnalyticsEvent): void {
  if (unloaded) {
    return;
  }
  if (pending.length >= MAX_BATCH_SIZE) {
    return;
  }
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

function takeBatch(): AnalyticsEvent[] {
  const batch = pending;
  pending = [];
  return batch;
}

async function flush(): Promise<void> {
  if (pending.length === 0) {
    return;
  }

  if (Date.now() < suppressUntil) {
    pending = [];
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch {
    pending = [];
    return;
  }

  const events = takeBatch();

  try {
    const res = await fetch(EVENTS_ENDPOINT, {
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

  let config;
  try {
    config = getConfig();
  } catch {
    pending = [];
    return;
  }

  const events = takeBatch();

  try {
    void fetch(EVENTS_ENDPOINT, {
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

// ---------------------------------------------------------------------------
// Custom event prop sanitization
// ---------------------------------------------------------------------------

function sanitizeProps(
  input?: Record<string, unknown>,
): CustomEventProps | undefined {
  if (!input) {
    return undefined;
  }
  const out: CustomEventProps = {};
  for (const [k, v] of Object.entries(input)) {
    if (
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Pageview emit
// ---------------------------------------------------------------------------

function emitPageview(url: string): void {
  try {
    const config = getConfig();
    enqueue({
      type: 'pageview',
      releaseId: config.releaseId,
      url,
      referrer: document.referrer,
      userAgent: navigator.userAgent,
      language: navigator.language,
      screen: { w: window.innerWidth, h: window.innerHeight },
      timestamp: Date.now(),
    });
  } catch {
    // capture must never crash
  }
}

// ---------------------------------------------------------------------------
// Public `track`
// ---------------------------------------------------------------------------

function track(event: string, props?: CustomEventProps): void {
  try {
    const config = getConfig();
    enqueue({
      type: 'event',
      releaseId: config.releaseId,
      name: event,
      url: location.href,
      timestamp: Date.now(),
      props: sanitizeProps(props as Record<string, unknown> | undefined),
    });
  } catch {
    // never crash
  }
}

// ---------------------------------------------------------------------------
// Silent presence connection
//
// The SDK opens a long-lived SSE connection to `/_/telemetry/presence`
// while the tab is alive. The connection itself is the presence signal:
// while it's open, the visitor is tracked as "online" in the server-side
// Redis set; when the tab closes (or network drops), the connection
// closes and the server immediately knows the visitor is gone.
//
// Any data the server pushes over this connection is silently discarded.
// The visitor-facing live count is intentionally NOT exposed by the SDK.
// The owner-facing dashboard reads counts via a separate authenticated
// internal endpoint, never through the SDK.
//
// Reading-and-discarding the stream is required to keep the underlying
// TCP buffer flowing — the open connection itself is what matters, not
// the data flowing over it.
// ---------------------------------------------------------------------------

const PRESENCE_ENDPOINT = '/_/telemetry/presence';
const PRESENCE_MAX_BACKOFF_MS = 10_000;
const PRESENCE_503_DEFAULT_MS = 30_000;

let presenceAbort: AbortController | null = null;
let presenceReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let presenceBackoffMs = 1000;
let presenceActive = false;

function presenceNextBackoff(): number {
  const base = presenceBackoffMs;
  presenceBackoffMs = Math.min(presenceBackoffMs * 2, PRESENCE_MAX_BACKOFF_MS);
  const jitter = Math.random() * 250;
  return base + jitter;
}

function schedulePresenceReconnect(ms: number): void {
  if (presenceReconnectTimer) {
    clearTimeout(presenceReconnectTimer);
  }
  presenceReconnectTimer = setTimeout(() => {
    presenceReconnectTimer = null;
    if (presenceActive) {
      void openPresenceConnection();
    }
  }, ms);
}

function closePresenceConnection(): void {
  presenceActive = false;
  if (presenceReconnectTimer) {
    clearTimeout(presenceReconnectTimer);
    presenceReconnectTimer = null;
  }
  if (presenceAbort) {
    try {
      presenceAbort.abort();
    } catch {
      // swallow
    }
    presenceAbort = null;
  }
}

async function openPresenceConnection(): Promise<void> {
  if (!presenceActive) {
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch {
    presenceActive = false;
    return;
  }

  presenceAbort = new AbortController();
  const signal = presenceAbort.signal;

  try {
    const res = await fetch(PRESENCE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'text/event-stream',
      },
      signal,
    });

    if (res.status === 503) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfterSec = retryAfterHeader
        ? parseInt(retryAfterHeader, 10)
        : NaN;
      const waitMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : PRESENCE_503_DEFAULT_MS;
      schedulePresenceReconnect(waitMs);
      return;
    }

    if (res.status === 401) {
      // Session bad — stop trying until something refreshes config
      presenceActive = false;
      return;
    }

    if (!res.ok || !res.body) {
      schedulePresenceReconnect(presenceNextBackoff());
      return;
    }

    // Successful connect — reset backoff
    presenceBackoffMs = 1000;

    const reader = res.body.getReader();

    // Drain and discard. The open connection is the presence signal;
    // any count data the server pushes is intentionally ignored.
    while (presenceActive) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }

    // Stream ended (server closed, deploy, etc.) — reconnect
    if (presenceActive) {
      schedulePresenceReconnect(presenceNextBackoff());
    }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (presenceActive && name !== 'AbortError') {
      schedulePresenceReconnect(presenceNextBackoff());
    }
  }
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export const analytics: AnalyticsClient = { track };

// ---------------------------------------------------------------------------
// Install + opt-out
// ---------------------------------------------------------------------------

let _installed = false;

/**
 * Install pageview auto-tracking + transport. Idempotent.
 *
 * Reads `window.__MINDSTUDIO__.telemetry?.analytics` — if explicitly
 * `false`, the SDK installs nothing and the function is a no-op.
 * `track()` calls also no-op in that case since enqueued events
 * have no flush path established.
 */
export function installAnalytics(): void {
  if (_installed) {
    return;
  }
  if (typeof window === 'undefined') {
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch {
    return;
  }

  if (config.telemetry?.analytics === false) {
    return;
  }

  _installed = true;

  // Unload listeners (attached once)
  const handleUnload = (): void => {
    unloaded = true;
    drainOnUnload();
    closePresenceConnection();
  };
  window.addEventListener('pagehide', handleUnload);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      drainOnUnload();
    }
  });

  // Auto-pageviews on every history change
  onNavigation((url) => {
    emitPageview(url);
  });

  // Initial pageview
  emitPageview(location.href);

  // Silent presence heartbeat — the open connection itself signals
  // "this visitor is online" to the server. No data is consumed.
  presenceActive = true;
  void openPresenceConnection();
}

/**
 * Wrapper that swallows any error from {@link installAnalytics} so a
 * misbehaving telemetry layer can never break `getConfig()`.
 *
 * @internal Called from config.ts on every `getConfig()` — idempotency
 *   is enforced inside `installAnalytics`.
 */
export function maybeInstallAnalytics(): void {
  try {
    installAnalytics();
  } catch {
    // telemetry must never crash the host app
  }
}
