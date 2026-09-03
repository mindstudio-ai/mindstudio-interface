/**
 * App events client — server→client realtime.
 *
 * Backend code publishes to named channels (`events.publish` in
 * `@mindstudio-ai/agent`); this client holds a platform-served SSE and
 * delivers matching publishes as they happen. Authorization is a **grant**
 * minted by one of the app's own backend methods — which is why `connect`
 * takes a token *provider*, not a token: grants expire on purpose (expiry is
 * the revocation window), and the SDK re-mints through your method on every
 * expiry, re-running your auth checks.
 *
 * ```ts
 * import { createClient, events } from '@mindstudio-ai/interface';
 * const api = createClient();
 *
 * const sub = events.connect({
 *   getToken: () => api.watchJobs().then((r) => r.token),
 *   onEvent: (e) => {
 *     if (e.channel.startsWith('jobs:')) refreshJob(e.data);
 *   },
 *   onConnect: () => refetchJobs(), // reconcile — see below
 * });
 *
 * // later (component unmount, page change):
 * sub.close();
 * ```
 *
 * ## Reconcile on connect
 *
 * Events are at-most-once nudges: nothing is buffered while you're
 * disconnected and nothing is replayed when you reconnect. `onConnect` fires
 * on EVERY (re)connect — network drop, grant expiry, server deploy — and is
 * where you refetch current state. Subscribe for speed, reconcile for truth;
 * a subscriber without an `onConnect` refetch will silently miss whatever
 * happened while it was away.
 *
 * ## Lifecycle
 *
 * - Grant expiry (`grant_expired` frame, every TTL window) → the SDK calls
 *   `getToken` again and reconnects. Invisible to the app beyond `onConnect`.
 * - Network drop → reconnect with backoff, reusing the still-valid token (no
 *   method invocation wasted).
 * - `getToken` throwing → terminal: your own method refused (logged out, role
 *   revoked), so the SDK calls `onError` and closes rather than retrying an
 *   authorization refusal in a loop. Call `connect` again when your app's
 *   auth state changes.
 */

import { withBase } from './config.js';
import { createSseLoop, type SseLoop } from './sse-loop.js';

/** One published event, delivered on a channel the grant names. */
export interface AppEvent {
  /**
   * Platform-stamped publish id. One publish = one id; if your grant covers
   * several of the published channels you receive it once per channel, so the
   * dedupe key is `id + channel`.
   */
  id: string;
  channel: string;
  data: unknown;
  /** Publish time, milliseconds since epoch. */
  ts: number;
}

export interface EventsConnectOptions {
  /**
   * Return a subscribe token — typically by invoking the backend method that
   * mints the grant (`events.grant` in the agent SDK) after its own auth
   * checks. Called on first connect and again after every grant expiry.
   * Throwing is terminal: `onError` fires and the subscription closes.
   */
  getToken: () => Promise<string> | string;
  /** A published event on one of the grant's channels. */
  onEvent: (event: AppEvent) => void;
  /**
   * Fires on every (re)connect. Refetch current state here — events are
   * at-most-once, so this is the correctness half of the contract.
   */
  onConnect?: () => void;
  /**
   * The server dropped `count` events for this connection because it couldn't
   * keep up (socket backpressure). Treat it like a reconnect: refetch current
   * state, same as `onConnect`. Without a handler the gap is silent — the
   * at-most-once contract already requires reconcile-on-connect, so this is
   * an extra hint, not a new obligation.
   */
  onGap?: (count: number) => void;
  /** Terminal failures only (a `getToken` refusal). Reconnects are silent. */
  onError?: (error: Error) => void;
}

export interface EventsSubscription {
  /** Stop the stream and all reconnection. Idempotent. */
  close(): void;
  /** `connecting` | `open` | `closed` */
  readonly state: 'connecting' | 'open' | 'closed';
  /**
   * Publish an ephemeral event on channels the grant carries **publish**
   * capability for (`events.grant(channels, { publish: [...] })` in the
   * backend SDK). This is the client-direct fast path — no backend method
   * runs; the platform fans out directly, so it's the right shape for
   * cursors, typing indicators, and live stroke batches.
   *
   * Fire-and-forget with automatic coalescing: call it per input event (per
   * mousemove is fine) and the SDK batches to ~40ms flushes. Delivery is
   * at-most-once and NOTHING here is retried — a stale cursor is worse than a
   * missing one. Payloads cap at 8k serialized; put a client `seq` in the
   * payload if receivers need cross-batch ordering. Truth still lives in your
   * database: commit durable state through a method, signal through this.
   */
  publish(channels: string | string[], data: unknown): void;
}

const EVENTS_ENDPOINT = '/_/events';

// Client-publish coalescing: flush cadence and the per-batch ceiling (kept
// under the platform's 100-event batch cap). 40ms caps sustained flushes at
// 25 POSTs/sec — headroom inside the platform's 30 batches/sec rate box; a
// faster timer (25ms) measured out at ~30/sec and grazed the box.
const PUBLISH_FLUSH_MS = 40;
const PUBLISH_MAX_BATCH = 50;

function connect(options: EventsConnectOptions): EventsSubscription {
  // The cached grant. Reused across network-drop reconnects (still valid, no
  // method call wasted); cleared when the server says it's dead — a
  // grant_expired frame, or a 401 on connect — so the next attempt re-mints.
  let token: string | null = null;

  const loop: SseLoop = createSseLoop({
    prepare: async () => {
      if (!token) {
        try {
          token = await options.getToken();
        } catch (err) {
          options.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
          return 'stop';
        }
      }
      return {
        url: withBase(EVENTS_ENDPOINT),
        headers: { Authorization: `Bearer ${token}` },
      };
    },
    onStatus: (status) => {
      if (status === 401) {
        // Grant expired or evicted between frames — re-mint on the retry.
        token = null;
      }
      return 'retry';
    },
    onOpen: () => {
      options.onConnect?.();
    },
    onLine: (line) => {
      if (!line.startsWith('data: ')) {
        return; // keepalive comments, blank frame separators
      }
      let parsed: any;
      try {
        parsed = JSON.parse(line.slice(6));
      } catch {
        return; // malformed frame — skip, matching the agent-chat reader
      }
      if (parsed?.type === 'grant_expired') {
        // Expected every TTL window. Clear the token; the server ends the
        // stream right after this frame and the loop's reconnect re-mints.
        token = null;
        return;
      }
      if (parsed?.type === 'events_dropped') {
        options.onGap?.(typeof parsed.count === 'number' ? parsed.count : 0);
        return;
      }
      if (typeof parsed?.channel === 'string') {
        options.onEvent({
          id: parsed.id,
          channel: parsed.channel,
          data: parsed.data,
          ts: parsed.ts,
        });
      }
    },
  });

  loop.start();

  //////////////////////////////////////////////////////////////////////////////
  // Client publish — fire-and-forget, coalesced. Failure policy is the
  // at-most-once contract applied upstream: ephemeral signals are dropped on
  // any failure, never queued or retried.
  //////////////////////////////////////////////////////////////////////////////

  let pending: Array<{ channels: string | string[]; data: unknown }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pausedUntil = 0; // 429 backoff
  let closed = false;
  let publishRefusalSurfaced = false;

  const flush = async () => {
    flushTimer = null;
    if (closed || pending.length === 0) {
      return;
    }
    if (!token || Date.now() < pausedUntil) {
      // Not connected (no grant yet) or rate-boxed: drop. A cursor position
      // from before the connection existed has no value after it.
      pending = [];
      return;
    }
    const events = pending;
    pending = [];
    try {
      const res = await fetch(withBase(EVENTS_ENDPOINT), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ events }),
      });
      if (res.status === 401) {
        // Grant died between frames — clear it so the SSE loop's reconnect
        // re-mints; the dropped batch is already stale.
        token = null;
        return;
      }
      if (res.status === 429) {
        const retryAfterSec = parseInt(
          res.headers.get('Retry-After') ?? '',
          10,
        );
        pausedUntil =
          Date.now() +
          (Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : 1000);
        return;
      }
      if (res.status === 403 && !publishRefusalSurfaced) {
        // The grant has no publish capability (or not for these channels) — a
        // programming error in the minting method, not a transient. Surface
        // once, keep dropping quietly after.
        publishRefusalSurfaced = true;
        options.onError?.(
          new Error(
            'events.publish refused: the grant does not carry publish ' +
              'capability for these channels — mint it with ' +
              '`events.grant(channels, { publish: [...] })`.',
          ),
        );
      }
    } catch {
      // Network blip — drop, at-most-once.
    }
  };

  const publish = (channels: string | string[], data: unknown) => {
    if (closed) {
      return;
    }
    pending.push({ channels, data });
    if (pending.length >= PUBLISH_MAX_BATCH) {
      if (flushTimer) {
        clearTimeout(flushTimer);
      }
      void flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), PUBLISH_FLUSH_MS);
    }
  };

  return {
    close: () => {
      closed = true;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending = [];
      loop.stop();
    },
    get state() {
      const s = loop.state;
      return s === 'open' ? 'open' : s === 'stopped' ? 'closed' : 'connecting';
    },
    publish,
  };
}

/**
 * The app-events client. `connect` opens a managed subscription — reconnects,
 * grant re-minting and backoff are handled internally; the app supplies the
 * token source and the handlers.
 */
export const events = { connect };
