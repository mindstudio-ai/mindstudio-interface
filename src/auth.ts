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

const authListeners: Set<(user: AppUser | null) => void> = new Set();

function applySession(bundle: AuthSessionBundle): void {
  updateConfig({
    token: bundle.token,
    user: bundle.user,
    methods: bundle.methods,
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
