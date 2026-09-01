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
  /** Terminal failures only (a `getToken` refusal). Reconnects are silent. */
  onError?: (error: Error) => void;
}

export interface EventsSubscription {
  /** Stop the stream and all reconnection. Idempotent. */
  close(): void;
  /** `connecting` | `open` | `closed` */
  readonly state: 'connecting' | 'open' | 'closed';
}

const EVENTS_ENDPOINT = '/_/events';

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
      if (typeof parsed?.channel === 'string') {
        options.onEvent({
          channel: parsed.channel,
          data: parsed.data,
          ts: parsed.ts,
        });
      }
    },
  });

  loop.start();

  return {
    close: () => loop.stop(),
    get state() {
      const s = loop.state;
      return s === 'open' ? 'open' : s === 'stopped' ? 'closed' : 'connecting';
    },
  };
}

/**
 * The app-events client. `connect` opens a managed subscription — reconnects,
 * grant re-minting and backoff are handled internally; the app supplies the
 * token source and the handlers.
 */
export const events = { connect };
