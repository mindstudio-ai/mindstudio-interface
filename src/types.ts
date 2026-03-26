/**
 * Type definitions for the @mindstudio-ai/interface SDK.
 *
 * These types describe the bootstrap globals injected by the platform,
 * the user context, and options for platform actions.
 */

// ---------------------------------------------------------------------------
// Bootstrap globals — injected by the platform into the iframe
// ---------------------------------------------------------------------------

/**
 * Bootstrap configuration injected into the page by the MindStudio
 * platform before the app's JavaScript runs.
 *
 * Available at `window.__MINDSTUDIO__`. The SDK reads this automatically —
 * app code should use `createClient()`, `auth`, and `platform` instead
 * of accessing this directly.
 *
 * Injection mechanism: The Cloudflare Worker on `*.static.mscdn.ai`
 * intercepts requests for `index.html`, injects a `<script>` tag with
 * the session context, and returns the modified HTML.
 */
export interface BootstrapConfig {
  /** Short-lived session token scoped to this app + user. */
  token: string;

  /** App ID. */
  appId: string;

  /** Current release ID. */
  releaseId: string;

  /** API base URL (e.g. "https://api.mindstudio.ai"). */
  apiBaseUrl: string;

  /** Resolved user fragment — display info for the current user. */
  user: BootstrapUser;

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

/**
 * Resolved user fragment. Includes display info so apps can render
 * personalized UI immediately without an extra API call.
 */
export interface BootstrapUser {
  /** User ID (UUID). */
  id: string;

  /** Display name. */
  name: string;

  /** Email address. */
  email: string;

  /** Profile picture URL, if set. */
  profilePictureUrl?: string;
}
