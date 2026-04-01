/**
 * Type definitions for the @mindstudio-ai/interface SDK.
 *
 * These types describe the bootstrap globals injected by the platform,
 * the authenticated user, and options for platform actions.
 */

// ---------------------------------------------------------------------------
// App user — the standardized user shape everywhere
// ---------------------------------------------------------------------------

/**
 * An authenticated app user. This is the same shape in
 * `window.__MINDSTUDIO__.user`, auth API responses, and
 * `auth.getCurrentUser()`.
 *
 * `null` means unauthenticated (app has auth enabled but no session).
 */
export interface AppUser {
  /** User ID (UUID) — matches the row ID in the app's user table. */
  id: string;

  /** Email address, or null if the user signed up via phone. */
  email: string | null;

  /** Phone number in E.164 format, or null if the user signed up via email. */
  phone: string | null;

  /** Role IDs assigned to this user. */
  roles: string[];

  /** ISO 8601 timestamp of when the user was created. */
  createdAt: string;
}

/**
 * Session bundle returned by auth endpoints that change state
 * (verify, change confirm, logout). Used internally by the SDK
 * to update the cached config in-place.
 */
export interface AuthSessionBundle {
  user: AppUser | null;
  token: string;
  methods: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Bootstrap globals — injected by the platform into the page
// ---------------------------------------------------------------------------

/**
 * Bootstrap configuration injected into the page by the MindStudio
 * platform before the app's JavaScript runs.
 *
 * Available at `window.__MINDSTUDIO__`. The SDK reads this automatically —
 * app code should use `createClient()`, `auth`, and `platform` instead
 * of accessing this directly.
 */
export interface BootstrapConfig {
  /** Short-lived session token scoped to this app + user. */
  token: string;

  /** App ID (optional — not needed for API calls, resolved from subdomain). */
  appId?: string;

  /** Current release ID. */
  releaseId: string;

  /** API base URL (optional — SDK uses same-origin `/_/` paths). */
  apiBaseUrl?: string;

  /**
   * Authenticated user, or `null` if unauthenticated.
   *
   * For apps with auth enabled: `null` until the user verifies.
   * For apps without auth: populated with a guest identity.
   */
  user: AppUser | null;

  /**
   * Method registry mapping export names to method IDs.
   * Embedded at injection time from the release manifest.
   *
   * @example
   * ```
   * { "submitVendorRequest": "submit-vendor-request", "getDashboard": "get-dashboard" }
   * ```
   */
  methods: Record<string, string>;
}
