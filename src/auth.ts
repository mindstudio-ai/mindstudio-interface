/**
 * Auth — app-managed authentication for MindStudio v2 apps.
 *
 * Provides verification code flows (email + SMS), session state
 * management, and phone/email validation helpers. The platform
 * handles code delivery, cookie management, and user storage —
 * developers build their own login UI using these methods.
 *
 * ## How it works
 *
 * ```
 * // 1. Send a verification code
 * const { verificationId } = await auth.sendEmailCode('user@example.com');
 *
 * // 2. User enters the code in your UI
 * const user = await auth.verifyEmailCode(verificationId, '123456');
 *
 * // 3. Session is now active — all SDK calls use the authenticated token
 * const result = await api.getDashboard(); // uses authenticated session
 * auth.getCurrentUser(); // { id, email, phone, roles, createdAt }
 * ```
 *
 * Verify, confirm, and logout methods update `window.__MINDSTUDIO__`
 * in-place so all downstream calls (method invocation, agent chat,
 * uploads) immediately use the new session. No page refresh needed.
 *
 * @example
 * ```tsx
 * import { auth } from '@mindstudio-ai/interface';
 *
 * function LoginPage() {
 *   const [email, setEmail] = useState('');
 *   const [verificationId, setVerificationId] = useState('');
 *   const [code, setCode] = useState('');
 *
 *   const handleSend = async () => {
 *     const { verificationId } = await auth.sendEmailCode(email);
 *     setVerificationId(verificationId);
 *   };
 *
 *   const handleVerify = async () => {
 *     await auth.verifyEmailCode(verificationId, code);
 *     // Session updated in-place — navigate to your app
 *     window.location.href = '/dashboard';
 *   };
 * }
 * ```
 */

import { getConfig, updateConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';
import type { AppUser, AuthSessionBundle } from './types.js';
import * as phoneHelpers from './auth-phone.js';
import * as emailHelpers from './auth-email.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function authFetch<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<T> {
  const config = getConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    let message = `Auth request failed: ${res.status} ${res.statusText}`;
    let code = 'auth_error';
    try {
      const err = (await res.json()) as { error?: string; code?: string };
      if (err.error) {
        message = err.error;
      }
      if (err.code) {
        code = err.code;
      }
    } catch {
      // Response wasn't JSON
    }
    throw new MindStudioInterfaceError(message, code, res.status);
  }

  return (await res.json()) as T;
}

// sessionStorage key holding the CSRF `state` for an in-flight top-level
// "Sign in with Remy" round-trip. Set by signInWithRemy(), validated + cleared
// by handleRemyRedirect(). (The embedded/popup flow keeps `state` in the
// opener's memory instead — see signInWithRemyPopup.)
const REMY_STATE_KEY = '__ms_remy_state';

// Embedded (iframe) flow: a query marker on the popup callback URL so the SDK
// instance that loads in the popup relays + closes instead of redeeming, and
// the postMessage discriminator the opener matches on.
const REMY_POPUP_MARKER = 'ms_popup';
const REMY_POPUP_MESSAGE = 'ms:remy:callback';

/** Generate an opaque, unguessable CSRF state value. */
function generateState(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  c?.getRandomValues?.(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Strip our own `code`/`state` params from the URL without a reload. */
function stripRemyRedirectParams(url: URL): void {
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  try {
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // history unavailable (e.g. non-browser) — nothing to clean
  }
}

const authListeners: Set<(user: AppUser | null) => void> = new Set();

function applySession(bundle: AuthSessionBundle): void {
  updateConfig({
    token: bundle.token,
    user: bundle.user,
    methods: bundle.methods,
    visitorId: bundle.visitorId,
  });
  authListeners.forEach((cb) => cb(bundle.user));
}

function requireUser(bundle: AuthSessionBundle): AppUser {
  if (!bundle.user) {
    throw new MindStudioInterfaceError(
      'Verification succeeded but no user was returned',
      'auth_error',
    );
  }
  return bundle.user;
}

function updateUserAndNotify(update: Partial<AppUser>): void {
  const config = getConfig();
  if (config.user) {
    Object.assign(config.user, update);
    authListeners.forEach((cb) => cb(config.user));
  }
}

/** True when the SDK is running inside a (cross-origin) iframe. */
function isEmbedded(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    // Cross-origin restrictions on reading window.top → we're definitely framed.
    return true;
  }
}

/**
 * Run the "Sign in with Remy" handshake in a top-level popup — used when the
 * app is embedded (a cross-origin iframe like the dev IDE preview). The
 * authorize page hard-denies framing, so it can only render as a first-party
 * top-level document. The popup relays its one-time code back to this window
 * (the opener) via postMessage; the exchange runs *here* so this context — the
 * one that must end up authenticated — owns the session. The `ms_iface_` token
 * from the response body is the source of truth (held in memory), so it works
 * regardless of whether the third-party `__ms_auth` cookie survives.
 */
function signInWithRemyPopup(
  redirectUri: string,
  state: string,
): Promise<AppUser | null> {
  // Tag the callback so the SDK instance that loads in the popup relays +
  // closes rather than redeeming in place.
  const callbackUrl = new URL(redirectUri, window.location.href);
  callbackUrl.searchParams.set(REMY_POPUP_MARKER, '1');

  const startUrl = `/_/auth/remy/start?${new URLSearchParams({
    redirect_uri: callbackUrl.toString(),
    state,
  }).toString()}`;

  // MUST open synchronously on the user's click — awaiting first spends the
  // gesture and the browser blocks the popup.
  const popup = window.open(startUrl, 'ms-remy-signin', 'width=480,height=720');
  if (!popup) {
    return Promise.reject(
      new MindStudioInterfaceError(
        'The sign-in popup was blocked. Allow popups for this site and try again.',
        'popup_blocked',
      ),
    );
  }

  return new Promise<AppUser | null>((resolve, reject) => {
    const appOrigin = window.location.origin;
    let settled = false;
    let receivedCode = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(pollTimer);
      clearTimeout(timeoutId);
      try {
        if (!popup.closed) {
          popup.close();
        }
      } catch {
        // ignore — closing a cross-context window can throw in rare cases
      }
      fn();
    };

    const onMessage = (event: MessageEvent): void => {
      // Hygiene: our exact origin, the window we opened, our shape, our state.
      if (event.origin !== appOrigin || event.source !== popup) {
        return;
      }
      const data = event.data as {
        type?: string;
        code?: string;
        state?: string;
      } | null;
      if (!data || data.type !== REMY_POPUP_MESSAGE || data.state !== state) {
        return; // not ours / stale / cross-talk / possible CSRF
      }

      // We have the code — a subsequent popup.closed must not read as "cancel".
      receivedCode = true;

      if (!data.code) {
        finish(() =>
          reject(
            new MindStudioInterfaceError(
              'Sign-in returned no code.',
              'auth_error',
            ),
          ),
        );
        return;
      }

      // Redeem in the opener: this is the context that must be authenticated.
      authFetch<AuthSessionBundle>('/_/auth/remy/exchange', 'POST', {
        code: data.code,
      })
        .then((bundle) => {
          applySession(bundle);
          finish(() => resolve(requireUser(bundle)));
        })
        .catch((err: unknown) => finish(() => reject(err)));
    };

    window.addEventListener('message', onMessage);

    // User closed the popup before finishing → cancelled (unless we already
    // received the code and are mid-exchange).
    const pollTimer = setInterval(() => {
      if (popup.closed && !receivedCode) {
        finish(() => resolve(null));
      }
    }, 400);

    // Backstop for a popup that never closes or posts (e.g. stuck on an error).
    const timeoutId = setTimeout(
      () =>
        finish(() =>
          reject(
            new MindStudioInterfaceError(
              'Sign-in timed out.',
              'signin_timeout',
            ),
          ),
        ),
      5 * 60 * 1000,
    );
  });
}

/**
 * If this window is the throwaway "Sign in with Remy" popup, relay the
 * one-time code to the opener and let it close us; returns `true` when it
 * handled the callback. Safe and synchronous — invoked both at SDK import
 * (before telemetry installs, so the popup fires no phantom pageview/presence)
 * and as a branch of {@link Auth.handleRemyRedirect}.
 *
 * @internal Not part of the public API surface.
 */
export function maybeRelayRemyPopupCallback(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  let params: URLSearchParams;
  try {
    params = new URL(window.location.href).searchParams;
  } catch {
    return false;
  }
  if (params.get(REMY_POPUP_MARKER) !== '1') {
    return false;
  }
  const code = params.get('code');
  if (!code) {
    return false;
  }

  const opener = window.opener as Window | null;
  if (!opener || opener === window) {
    // No channel back to the app — e.g. COOP severed the opener. Redeeming
    // here would authenticate the throwaway popup, which the storage-
    // partitioned iframe can't use, so we deliberately do nothing.
    return false;
  }

  try {
    opener.postMessage(
      {
        type: REMY_POPUP_MESSAGE,
        code,
        state: params.get('state') ?? undefined,
      },
      window.location.origin,
    );
  } catch {
    return false;
  }

  // The opener closes us after the exchange; self-close on the next tick is a
  // backstop in case it isn't listening.
  try {
    setTimeout(() => window.close(), 0);
  } catch {
    // ignore
  }
  return true;
}

/**
 * Options for {@link Auth.signInWithRemy}.
 */
export interface SignInWithRemyOptions {
  /**
   * The same-origin URL the platform should return the browser to after
   * resolving access. Must be an origin the app actually serves on (the
   * backend validates it against the app's allow-list).
   *
   * @default `window.location.href` — the user lands back where they started.
   */
  redirectUri?: string;

  /**
   * CSRF token round-tripped through the redirect. Provide your own to
   * correlate the return with app state; otherwise an opaque random value
   * is generated. Validated on return by {@link Auth.handleRemyRedirect}
   * (top-level flow) or by the opener (embedded/popup flow).
   */
  state?: string;

  /**
   * How to run the handshake.
   *
   * - `'auto'` (default) — full-page redirect when the app is top-level; a
   *   popup when it's embedded in a cross-origin iframe (the authorize page
   *   can't be framed, so a redirect there would fail).
   * - `'popup'` — always use a popup.
   * - `'redirect'` — always use a full-page redirect.
   *
   * @default 'auto'
   */
  mode?: 'auto' | 'popup' | 'redirect';
}

// ---------------------------------------------------------------------------
// Auth interface
// ---------------------------------------------------------------------------

/**
 * The auth namespace — authentication flows, state, and helpers.
 *
 * Auth methods throw {@link MindStudioInterfaceError} on failure.
 * Common error codes:
 *
 * | Code | Status | Meaning |
 * |------|--------|---------|
 * | `rate_limited` | 429 | Too many code requests (max 5 per 15 min per identifier) |
 * | `invalid_code` | 400 | Wrong verification code |
 * | `verification_expired` | 400 | Code expired (10 min TTL) — request a new one |
 * | `max_attempts_exceeded` | 400 | Too many incorrect attempts (max 3) — request a new code |
 * | `not_authenticated` | 401 | Auth cookie missing (change/logout endpoints) |
 * | `invalid_session` | 401 | Auth cookie expired or invalid |
 */
export interface Auth {
  // -- State --

  /** The current authenticated user, or `null` if not authenticated. */
  readonly currentUser: AppUser | null;

  /** Get the current authenticated user, or `null` if not authenticated. */
  getCurrentUser(): AppUser | null;

  /** Whether the current session is authenticated. */
  isAuthenticated(): boolean;

  /**
   * The stable per-browser, per-app visitor identifier, or `null` if
   * unavailable (e.g. cached bootstrap from before this field existed).
   *
   * Opaque string backed by a server-set HttpOnly cookie. For authed
   * sessions this is the user's platform user ID; for guests it's a
   * per-browser UUID. Persists ~1 year; refreshed on each page load.
   * Updates in-place on login/logout transitions.
   */
  readonly currentVisitorId: string | null;

  /** Get the current visitor ID, or `null` if unavailable. */
  getCurrentVisitorId(): string | null;

  // -- Email code flow --

  /** Send a 6-digit verification code to an email address. */
  sendEmailCode(email: string): Promise<{ verificationId: string }>;

  /**
   * Verify an email code. On success, updates the session in-place
   * and returns the authenticated user.
   */
  verifyEmailCode(verificationId: string, code: string): Promise<AppUser>;

  // -- SMS code flow --

  /** Send a 6-digit verification code via SMS. Phone must be E.164. */
  sendSmsCode(phone: string): Promise<{ verificationId: string }>;

  /**
   * Verify an SMS code. On success, updates the session in-place
   * and returns the authenticated user.
   */
  verifySmsCode(verificationId: string, code: string): Promise<AppUser>;

  // -- Sign in with Remy (platform-delegated) --

  /**
   * Start the "Sign in with Remy" flow. The platform — not the app — decides
   * who the person is and whether they're allowed (think "Sign in with
   * Google"). Auto-detects the context:
   *
   * - **Top-level** (production, standalone tab): redirects the browser to the
   *   platform and bounces back to `redirectUri` with a one-time code that
   *   {@link handleRemyRedirect} redeems on return. **The page navigates away**,
   *   so the returned promise never settles.
   * - **Embedded** (cross-origin iframe, e.g. the dev IDE preview): opens a
   *   top-level popup for the handshake (the authorize page can't be framed).
   *   The returned promise resolves with the user on success, `null` if the
   *   user closes the popup, or rejects (`popup_blocked` / `invalid_state` /
   *   `signin_timeout` / exchange error). `onAuthStateChanged` also fires on
   *   success.
   *
   * Must be called from a user gesture (e.g. a click) so the popup isn't
   * blocked. Override the auto-detection with `options.mode`.
   *
   * @example
   * ```ts
   * // "Continue with {Org}" button — works top-level or embedded:
   * <button onClick={() => auth.signInWithRemy()}>Continue with Acme</button>
   *
   * // Await the result in an embedded app:
   * const user = await auth.signInWithRemy();
   * if (user) navigate('/dashboard');
   * ```
   */
  signInWithRemy(options?: SignInWithRemyOptions): Promise<AppUser | null>;

  /**
   * Complete a "Sign in with Remy" redirect. Call once on app load — it's a
   * no-op (resolves `null`) when there's no code to redeem, so it's safe to
   * run on every mount.
   *
   * Handles both entry points:
   * - **SP-initiated** (returned from {@link signInWithRemy}) — validates the
   *   round-tripped CSRF `state` against the value stashed at start.
   * - **IdP-initiated** (opened from the Remy dashboard) — a `?code=` lands on
   *   first paint with no `state`; the single-use, app-bound code is the
   *   control, so it's redeemed directly.
   *
   * On success, updates the session in-place (fires `onAuthStateChanged`),
   * strips `code`/`state` from the URL, and returns the authenticated user.
   *
   * @returns The authenticated user, or `null` if there was no code to redeem.
   * @throws `invalid_state` if a returned `state` doesn't match the stashed one.
   *
   * @example
   * ```ts
   * useEffect(() => { auth.handleRemyRedirect(); }, []);
   * useEffect(() => auth.onAuthStateChanged(setUser), []);
   * ```
   */
  handleRemyRedirect(): Promise<AppUser | null>;

  // -- Email/phone change (requires authentication) --

  /** Request an email change. Sends a code to the new email. */
  requestEmailChange(newEmail: string): Promise<void>;

  /** Confirm an email change with the verification code. */
  confirmEmailChange(newEmail: string, code: string): Promise<AppUser>;

  /** Request a phone change. Sends a code to the new phone (E.164). */
  requestPhoneChange(newPhone: string): Promise<void>;

  /** Confirm a phone change with the verification code. */
  confirmPhoneChange(newPhone: string, code: string): Promise<AppUser>;

  // -- Session --

  /** Log out. Clears the cookie and updates the session to unauthenticated. */
  logout(): Promise<void>;

  // -- API keys --

  /**
   * Generate an API key for the current user. Returns the full key
   * (shown once). The user's `apiKey` field updates to the masked
   * value and `onAuthStateChanged` fires.
   *
   * @throws `not_authenticated` (401) if no session
   * @throws `not_supported` (400) if api-key auth is not enabled
   */
  createApiKey(): Promise<{ key: string }>;

  /**
   * Revoke the current user's API key. The user's `apiKey` field
   * becomes `null` and `onAuthStateChanged` fires.
   *
   * @throws `not_authenticated` (401) if no session
   */
  revokeApiKey(): Promise<void>;

  /**
   * Subscribe to auth state changes. Fires immediately with the
   * current state, then again whenever verify, confirm, or logout
   * updates the session.
   *
   * @returns An unsubscribe function.
   *
   * @example
   * ```ts
   * // React hook
   * function useAuth() {
   *   const [user, setUser] = useState<AppUser | null>(null);
   *   useEffect(() => auth.onAuthStateChanged(setUser), []);
   *   return user;
   * }
   * ```
   */
  onAuthStateChanged(callback: (user: AppUser | null) => void): () => void;

  // -- Helpers --

  /** Phone number utilities — countries, formatting, validation. */
  phone: {
    /** All countries with dial codes, sorted alphabetically. */
    countries: readonly phoneHelpers.Country[];
    /** Detect the user's country from their timezone. Falls back to `'US'`. */
    detectCountry(): string;
    /** Format an E.164 number for display (e.g. `+1 (555) 123-4567`). */
    format(e164: string): string;
    /** Convert a national number to E.164 (e.g. `('5551234567', 'US') → '+15551234567'`). */
    toE164(national: string, countryCode: string): string;
    /** Check if a string is a valid E.164 phone number. */
    isValid(phone: string): boolean;
  };

  /** Email validation. */
  email: {
    /** Basic email format check. */
    isValid(email: string): boolean;
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const auth: Auth = {
  // -- State --

  get currentUser() {
    return getConfig().user;
  },

  getCurrentUser() {
    return getConfig().user;
  },

  isAuthenticated() {
    return getConfig().user !== null;
  },

  get currentVisitorId() {
    return getConfig().visitorId ?? null;
  },

  getCurrentVisitorId() {
    return getConfig().visitorId ?? null;
  },

  // -- Email code flow --

  sendEmailCode(email: string) {
    return authFetch<{ verificationId: string }>('/_/auth/email/send', 'POST', {
      email,
    });
  },

  async verifyEmailCode(verificationId: string, code: string) {
    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/email/verify',
      'POST',
      { verificationId, code },
    );
    applySession(bundle);
    return requireUser(bundle);
  },

  // -- SMS code flow --

  sendSmsCode(phone: string) {
    return authFetch<{ verificationId: string }>('/_/auth/sms/send', 'POST', {
      phone,
    });
  },

  async verifySmsCode(verificationId: string, code: string) {
    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/sms/verify',
      'POST',
      { verificationId, code },
    );
    applySession(bundle);
    return requireUser(bundle);
  },

  // -- Sign in with Remy --

  signInWithRemy(options?: SignInWithRemyOptions): Promise<AppUser | null> {
    const mode = options?.mode ?? 'auto';
    const usePopup = mode === 'popup' || (mode === 'auto' && isEmbedded());
    const redirectUri = options?.redirectUri ?? window.location.href;
    const state = options?.state ?? generateState();

    if (usePopup) {
      // window.open must happen synchronously on the gesture — do it first.
      return signInWithRemyPopup(redirectUri, state);
    }

    // Top-level full-page redirect. The opener/popup handshake isn't needed,
    // so the CSRF `state` is stashed for handleRemyRedirect() to validate.
    try {
      sessionStorage.setItem(REMY_STATE_KEY, state);
    } catch {
      // sessionStorage unavailable (private mode / disabled) — proceed
      // without the CSRF stash; the one-time, app-bound code still gates.
    }

    const params = new URLSearchParams({ redirect_uri: redirectUri, state });
    window.location.assign(`/_/auth/remy/start?${params.toString()}`);

    // The page is navigating away — nothing after this resolves.
    return new Promise<AppUser | null>(() => {});
  },

  async handleRemyRedirect() {
    if (typeof window === 'undefined') {
      return null;
    }

    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    if (!code) {
      return null;
    }

    // Embedded/popup callback: relay the code to the opener and let it close
    // us — never redeem here (the opener owns the session). The import-time
    // fast path usually handles this already; this is the fallback for apps
    // that call handleRemyRedirect() directly.
    if (url.searchParams.get(REMY_POPUP_MARKER) === '1') {
      maybeRelayRemyPopupCallback();
      return null;
    }

    const returnedState = url.searchParams.get('state');

    // We're committed to consuming this redirect — strip the params up front
    // so a refresh never retries a spent (or failed) one-time code.
    stripRemyRedirectParams(url);

    let storedState: string | null = null;
    try {
      storedState = sessionStorage.getItem(REMY_STATE_KEY);
      sessionStorage.removeItem(REMY_STATE_KEY);
    } catch {
      // sessionStorage unavailable — CSRF check degrades to redeem-only.
    }

    // SP-initiated returns round-trip a `state` that must match what we
    // stashed. IdP-initiated launches carry no `state` — the single-use,
    // app-bound, short-lived code is the control there.
    if (returnedState !== null && returnedState !== storedState) {
      throw new MindStudioInterfaceError(
        'Sign-in state mismatch — possible CSRF or a stale redirect. Please try again.',
        'invalid_state',
      );
    }

    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/remy/exchange',
      'POST',
      { code },
    );
    applySession(bundle);
    return requireUser(bundle);
  },

  // -- Email/phone change --

  async requestEmailChange(newEmail: string) {
    await authFetch('/_/auth/email/change', 'POST', { newEmail });
  },

  async confirmEmailChange(newEmail: string, code: string) {
    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/email/change/confirm',
      'POST',
      { newEmail, code },
    );
    applySession(bundle);
    return requireUser(bundle);
  },

  async requestPhoneChange(newPhone: string) {
    await authFetch('/_/auth/phone/change', 'POST', { newPhone });
  },

  async confirmPhoneChange(newPhone: string, code: string) {
    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/phone/change/confirm',
      'POST',
      { newPhone, code },
    );
    applySession(bundle);
    return requireUser(bundle);
  },

  // -- Session --

  async logout() {
    const bundle = await authFetch<AuthSessionBundle>(
      '/_/auth/logout',
      'POST',
      {},
    );
    applySession(bundle);
  },

  async createApiKey() {
    const result = await authFetch<{ key: string; apiKey: string }>(
      '/_/auth/api-key/create',
      'POST',
      {},
    );
    updateUserAndNotify({ apiKey: result.apiKey });
    return { key: result.key };
  },

  async revokeApiKey() {
    await authFetch('/_/auth/api-key/revoke', 'POST', {});
    updateUserAndNotify({ apiKey: null });
  },

  onAuthStateChanged(callback: (user: AppUser | null) => void) {
    authListeners.add(callback);
    callback(getConfig().user);
    return () => {
      authListeners.delete(callback);
    };
  },

  // -- Helpers --

  phone: {
    countries: phoneHelpers.countries,
    detectCountry: phoneHelpers.detectCountry,
    format: phoneHelpers.format,
    toE164: phoneHelpers.toE164,
    isValid: phoneHelpers.isValid,
  },

  email: {
    isValid: emailHelpers.isValid,
  },
};
