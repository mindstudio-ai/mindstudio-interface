/**
 * Breadcrumbs — a ring buffer of recent navigations + network calls
 * attached to outgoing error reports for debugging context.
 *
 * Installed by `installErrorMonitoring()` in `telemetry-errors.ts`.
 * Three monkeypatches feed the buffer:
 *
 * - `history.pushState`/`replaceState`/`popstate` → `navigation`
 * - `window.fetch`                                → `fetch`
 * - `XMLHttpRequest.prototype.open`/`send`        → `xhr`
 *
 * Each patch is idempotent — guarded by a `__ms_*_patched` flag so
 * re-imports (HMR, double bundle inclusion, etc.) are no-ops.
 *
 * The SDK's own telemetry endpoint is excluded from capture so error
 * reports don't feed themselves through the breadcrumb pipeline.
 */

const TELEMETRY_ENDPOINT_FRAGMENT = '/_/telemetry/';
const MAX_BREADCRUMBS = 20;
const MAX_BODY_BYTES = 1024;

/**
 * A single breadcrumb entry. Discriminated union — server validates the
 * `type` field; unknown types are dropped at ingest.
 */
export type Breadcrumb =
  | {
      type: 'navigation';
      from: string;
      to: string;
      timestamp: number;
    }
  | {
      type: 'fetch';
      method: string;
      url: string;
      status?: number;
      ok: boolean;
      duration: number;
      timestamp: number;
      error?: string;
      /** Truncated response body for failed requests, when capture is enabled. */
      body?: string;
    }
  | {
      type: 'xhr';
      method: string;
      url: string;
      status?: number;
      ok: boolean;
      duration: number;
      timestamp: number;
    };

const buffer: Breadcrumb[] = [];

function push(entry: Breadcrumb): void {
  buffer.push(entry);
  if (buffer.length > MAX_BREADCRUMBS) {
    buffer.shift();
  }
}

/**
 * Return a shallow copy of the current breadcrumb buffer.
 * Called when an error is captured to snapshot context at that moment.
 */
export function getBreadcrumbs(): Breadcrumb[] {
  return buffer.slice();
}

function shouldSkipUrl(url: string): boolean {
  return url.includes(TELEMETRY_ENDPOINT_FRAGMENT);
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url || String(input);
}

let lastHref = '';

const navListeners = new Set<(url: string) => void>();

/**
 * Subscribe to navigation events. Fires on every history change
 * (`pushState`, `replaceState`, `popstate`, `hashchange`) with the new URL.
 *
 * Used by the analytics module to emit pageview events without
 * installing a second set of history patches.
 *
 * @returns Unsubscribe function.
 */
export function onNavigation(cb: (url: string) => void): () => void {
  navListeners.add(cb);
  return () => {
    navListeners.delete(cb);
  };
}

function emitNavigation(to: string): void {
  if (to === lastHref) {
    return;
  }
  push({
    type: 'navigation',
    from: lastHref,
    to,
    timestamp: Date.now(),
  });
  lastHref = to;
  navListeners.forEach((cb) => {
    try {
      cb(to);
    } catch {
      // listener errors must not break navigation
    }
  });
}

function installHistory(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__ms_history_patched) {
    return;
  }
  w.__ms_history_patched = true;

  lastHref = location.href;

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPushState(data, unused, url);
    try {
      emitNavigation(location.href);
    } catch {
      // never crash navigation
    }
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplaceState(data, unused, url);
    try {
      emitNavigation(location.href);
    } catch {
      // never crash navigation
    }
  };

  window.addEventListener('popstate', () => {
    try {
      emitNavigation(location.href);
    } catch {
      // swallow
    }
  });

  window.addEventListener('hashchange', () => {
    try {
      emitNavigation(location.href);
    } catch {
      // swallow
    }
  });
}

function installFetch(captureResponseBodies: boolean): void {
  if (!window.fetch) {
    return;
  }
  const fetchFn = window.fetch as typeof fetch & { __ms_patched?: boolean };
  if (fetchFn.__ms_patched) {
    return;
  }

  const originalFetch = window.fetch.bind(window);

  const patched: typeof fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveUrl(input);

    if (shouldSkipUrl(url)) {
      return originalFetch(input, init);
    }

    const method = (
      init?.method ||
      (typeof input !== 'string' && !(input instanceof URL)
        ? input.method
        : '') ||
      'GET'
    ).toUpperCase();
    const startTime = Date.now();

    return originalFetch(input, init).then(
      (response) => {
        const entry: Breadcrumb = {
          type: 'fetch',
          method,
          url,
          status: response.status,
          ok: response.ok,
          duration: Date.now() - startTime,
          timestamp: startTime,
        };

        if (!response.ok && captureResponseBodies) {
          try {
            response
              .clone()
              .text()
              .then((body) => {
                entry.body = body.slice(0, MAX_BODY_BYTES);
                push(entry);
              })
              .catch(() => push(entry));
          } catch {
            push(entry);
          }
        } else {
          push(entry);
        }

        return response;
      },
      (err: unknown) => {
        push({
          type: 'fetch',
          method,
          url,
          ok: false,
          duration: Date.now() - startTime,
          timestamp: startTime,
          error:
            err instanceof Error ? err.message : String(err ?? 'fetch failed'),
        });
        throw err;
      },
    );
  };

  (patched as typeof fetch & { __ms_patched: boolean }).__ms_patched = true;
  window.fetch = patched;
}

function installXhr(): void {
  const openProto = XMLHttpRequest.prototype.open as ((
    ...args: unknown[]
  ) => void) & { __ms_patched?: boolean };
  if (openProto.__ms_patched) {
    return;
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest & {
      __ms_method?: string;
      __ms_url?: string;
    },
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    this.__ms_method = (method || 'GET').toUpperCase();
    this.__ms_url = String(url);
    return originalOpen.apply(this, [method, url, ...rest] as Parameters<
      typeof originalOpen
    >);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function (
    this: XMLHttpRequest & {
      __ms_method?: string;
      __ms_url?: string;
    },
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const method = this.__ms_method || 'GET';
    const url = this.__ms_url || '';

    if (shouldSkipUrl(url)) {
      return originalSend.apply(this, [body] as Parameters<
        typeof originalSend
      >);
    }

    const startTime = Date.now();

    this.addEventListener(
      'loadend',
      function (this: XMLHttpRequest) {
        push({
          type: 'xhr',
          method,
          url,
          status: this.status,
          ok: this.status >= 200 && this.status < 300,
          duration: Date.now() - startTime,
          timestamp: startTime,
        });
      },
      { once: true },
    );

    return originalSend.apply(this, [body] as Parameters<typeof originalSend>);
  } as typeof XMLHttpRequest.prototype.send;

  (
    XMLHttpRequest.prototype.open as typeof XMLHttpRequest.prototype.open & {
      __ms_patched: boolean;
    }
  ).__ms_patched = true;
}

let _breadcrumbsInstalled = false;

/**
 * Install all three breadcrumb sources. Idempotent.
 *
 * @param opts.captureResponseBodies — when `true`, failed `fetch`
 *   responses have their bodies read and attached (truncated to ~1KB).
 *   Backend strips this field unless the per-app setting is enabled.
 */
export function installBreadcrumbs(opts: {
  captureResponseBodies: boolean;
}): void {
  if (_breadcrumbsInstalled) {
    return;
  }
  _breadcrumbsInstalled = true;

  try {
    installHistory();
  } catch {
    // history patches are best-effort
  }
  try {
    installFetch(opts.captureResponseBodies);
  } catch {
    // fetch patches are best-effort
  }
  try {
    installXhr();
  } catch {
    // xhr patches are best-effort
  }
}
