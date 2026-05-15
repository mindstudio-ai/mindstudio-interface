/**
 * @mindstudio-ai/interface — Frontend SDK for MindStudio v2 app interfaces.
 *
 * Provides typed RPC to backend methods, file uploads, authentication,
 * and agent chat conversations. Runs inside web interfaces with
 * credentials injected by the platform via `window.__MINDSTUDIO__`.
 *
 * ## Four exports
 *
 * - `createClient()` — typed method RPC client
 * - `createAgentChatClient()` — thread-based agent conversations
 * - `platform` — file upload actions
 * - `auth` — authentication flows, user state, and validation helpers
 *
 * @example
 * ```ts
 * import {
 *   createClient,
 *   createAgentChatClient,
 *   platform,
 *   auth,
 * } from '@mindstudio-ai/interface';
 *
 * const api = createClient();
 * const chat = createAgentChatClient();
 *
 * // Check auth state
 * if (!auth.isAuthenticated()) {
 *   const { verificationId } = await auth.sendEmailCode('user@example.com');
 *   await auth.verifyEmailCode(verificationId, code);
 * }
 *
 * // Call backend methods (uses authenticated session)
 * const dashboard = await api.getDashboard();
 *
 * // Upload a file
 * const url = await platform.uploadFile(file);
 *
 * // Current user
 * const user = auth.getCurrentUser();
 * ```
 */

export { createClient, type InvokeOptions } from './client.js';
export {
  createAgentChatClient,
  type AgentChatClient,
  type AgentChatEvent,
  type SendMessageCallbacks,
  type SendMessageOptions,
  type SendMessageResult,
  type AbortablePromise,
  type Thread,
  type ThreadSummary,
  type ThreadListPage,
  type Message,
} from './agent-chat.js';
export { platform, type UploadFileOptions } from './platform.js';
export { auth, type Auth } from './auth.js';
export {
  analytics,
  type AnalyticsClient,
  type CustomEventProps,
} from './telemetry-analytics.js';
export { MindStudioInterfaceError } from './errors.js';
export type { BootstrapConfig, AppUser } from './types.js';
export type { Country } from './auth-phone.js';
export type { Breadcrumb } from './telemetry-breadcrumbs.js';

// ---------------------------------------------------------------------------
// Eager telemetry init
//
// When `window.__MINDSTUDIO__` is present at import time, trigger `getConfig()`
// on the next tick so telemetry surfaces (errors, analytics, presence) install
// at page load rather than on first SDK use. Without this, an app that creates
// an `api` proxy at the module top but only invokes it from user interactions
// would have no telemetry until the user clicks something.
//
// In environments without the bootstrap (SSR/Node, tests, dev without platform
// context), the guard skips this and the SDK falls back to lazy init — first
// SDK method call triggers `getConfig()` exactly as before.
// ---------------------------------------------------------------------------

import { getConfig } from './config.js';

if (
  typeof window !== 'undefined' &&
  (globalThis as Record<string, unknown>).__MINDSTUDIO__
) {
  setTimeout(() => {
    try {
      getConfig();
    } catch {
      // bootstrap reads can still happen lazily on first SDK call
    }
  }, 0);
}
