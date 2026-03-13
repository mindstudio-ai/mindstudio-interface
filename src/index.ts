/**
 * @mindstudio-ai/interface — Frontend SDK for MindStudio v2 app interfaces.
 *
 * Provides typed RPC to backend methods, platform actions (file picker,
 * uploads), and current user context. Runs inside web interfaces
 * (iframes on *.static.mscdn.ai) with credentials injected by the platform.
 *
 * ## Three exports
 *
 * - `createClient()` — typed method RPC client
 * - `platform` — file picker and upload actions
 * - `auth` — current user identity (display only)
 *
 * @example
 * ```ts
 * import { createClient, platform, auth } from '@mindstudio-ai/interface';
 *
 * const api = createClient();
 *
 * // Call backend methods
 * const dashboard = await api.getDashboard();
 *
 * // Open the file picker
 * const url = await platform.requestFile({ type: 'image' });
 *
 * // Display user info
 * console.log(auth.name, auth.profilePictureUrl);
 * ```
 */

export { createClient, type InvokeOptions } from './client.js';
export { platform } from './platform.js';
export { auth, type AuthContext } from './auth.js';
export { MindStudioInterfaceError } from './errors.js';
export type {
  BootstrapConfig,
  BootstrapUser,
  RequestFileOptions,
} from './types.js';
