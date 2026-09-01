/**
 * Long-lived SSE connection loop — the reconnect discipline shared by the
 * presence heartbeat (telemetry-analytics.ts) and the app-events client
 * (events.ts). Extracted from the presence client rather than copied, so the
 * hard-won rules can't drift between consumers:
 *
 * - Exponential backoff with jitter, capped, and a STABLE-CONNECTION
 *   threshold before the backoff resets — resetting on a bare 200 lets a
 *   stream that dies instantly reconnect every ~1s forever, so a connection
 *   only earns the reset by staying open.
 * - `Retry-After` honored on 503 (the server's capacity signal).
 * - `fetch` + reader, never `EventSource`, so credentials ride the
 *   `Authorization` header instead of a URL.
 *
 * Policy stays in the consumer: `prepare` builds each attempt's request (and
 * can stop the loop), `onStatus` decides what a non-OK response means, and
 * `onLine` interprets the stream. Presence discards lines and stops on
 * 401/204; events parses frames and re-mints its grant.
 */

export interface SseLoopOptions {
  /**
   * Build the next attempt's request. Called before EVERY connect, so a
   * consumer can refresh credentials per attempt. Return `'stop'` to end the
   * loop (e.g. config gone, credential refusal).
   */
  prepare: () =>
    | Promise<{ url: string; headers: Record<string, string> } | 'stop'>
    | { url: string; headers: Record<string, string> }
    | 'stop';
  /**
   * Policy for any unreadable response — an error status, or a bodyless
   * success like 204. `'retry'` schedules a backoff reconnect; `'stop'` ends
   * the loop. 503 never reaches this hook (the loop honors Retry-After
   * itself). Default: `'retry'`.
   */
  onStatus?: (status: number) => 'retry' | 'stop';
  /** One complete line from the stream, `\n`-split, terminator stripped. */
  onLine?: (line: string) => void;
  /** The stream opened (2xx with a body). Fires on every (re)connect. */
  onOpen?: () => void;
  /** The loop ended for good — `stop()`, a `'stop'` policy, or `prepare` said so. */
  onStop?: () => void;
}

export interface SseLoop {
  start(): void;
  stop(): void;
  readonly state: 'idle' | 'connecting' | 'open' | 'stopped';
}

/** @internal Timing knobs, injectable so tests don't wait wall-clock. */
export interface SseLoopTiming {
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** Minimum open-stream lifetime that earns a backoff reset. */
  stableMs: number;
  /** Wait after a 503 with no usable Retry-After. */
  retry503DefaultMs: number;
}

const DEFAULT_TIMING: SseLoopTiming = {
  initialBackoffMs: 1000,
  maxBackoffMs: 10_000,
  stableMs: 30_000,
  retry503DefaultMs: 30_000,
};

export function createSseLoop(
  options: SseLoopOptions,
  timing: SseLoopTiming = DEFAULT_TIMING,
): SseLoop {
  let active = false;
  let state: SseLoop['state'] = 'idle';
  let abort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = timing.initialBackoffMs;

  const nextBackoff = (): number => {
    const base = backoffMs;
    backoffMs = Math.min(backoffMs * 2, timing.maxBackoffMs);
    return base + Math.random() * 250;
  };

  const scheduleReconnect = (ms: number): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (active) {
        void connect();
      }
    }, ms);
  };

  const halt = (): void => {
    if (!active && state === 'stopped') {
      return;
    }
    active = false;
    state = 'stopped';
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (abort) {
      try {
        abort.abort();
      } catch {
        // swallow
      }
      abort = null;
    }
    options.onStop?.();
  };

  async function connect(): Promise<void> {
    if (!active) {
      return;
    }
    state = 'connecting';

    let request: { url: string; headers: Record<string, string> } | 'stop';
    try {
      request = await options.prepare();
    } catch {
      // prepare() throwing is a consumer bug or a deliberate refusal it
      // should have expressed as 'stop' — either way, looping on it is worse.
      halt();
      return;
    }
    if (request === 'stop' || !active) {
      halt();
      return;
    }

    abort = new AbortController();
    const signal = abort.signal;

    try {
      const res = await fetch(request.url, {
        method: 'GET',
        headers: { ...request.headers, Accept: 'text/event-stream' },
        signal,
      });

      if (!active) {
        return;
      }

      if (res.status === 503) {
        const retryAfterSec = parseInt(
          res.headers.get('Retry-After') ?? '',
          10,
        );
        const waitMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec * 1000
            : timing.retry503DefaultMs;
        scheduleReconnect(waitMs);
        return;
      }

      // Anything unreadable — an error status, or a bodyless success like 204
      // (which the dev-tunnel presence mock uses to mean "don't reconnect") —
      // goes through the consumer's policy hook.
      if (!res.ok || !res.body) {
        if ((options.onStatus?.(res.status) ?? 'retry') === 'stop') {
          halt();
        } else {
          scheduleReconnect(nextBackoff());
        }
        return;
      }

      // Note the connect time — but don't reset the backoff yet. Only a
      // stream that stays open long enough to be healthy earns the reset.
      const connectedAt = Date.now();
      state = 'open';
      options.onOpen?.();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (active) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!options.onLine) {
          continue; // drain-and-discard consumer (presence)
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          options.onLine(line.replace(/\r$/, ''));
        }
      }

      if (active) {
        if (Date.now() - connectedAt >= timing.stableMs) {
          backoffMs = timing.initialBackoffMs;
        }
        state = 'connecting';
        scheduleReconnect(nextBackoff());
      }
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (active && name !== 'AbortError') {
        state = 'connecting';
        scheduleReconnect(nextBackoff());
      }
    }
  }

  return {
    start() {
      if (active) {
        return;
      }
      active = true;
      void connect();
    },
    stop: halt,
    get state() {
      return state;
    },
  };
}
