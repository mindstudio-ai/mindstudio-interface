/**
 * @mindstudio-ai/interface — Frontend SDK for MindStudio v2 app interfaces.
 *
 * Provides typed RPC to backend methods, file uploads, and current user
 * context. Runs inside web interfaces with credentials injected by the
 * platform via `window.__MINDSTUDIO__`.
 *
 * ## Three exports
 *
 * - `createClient()` — typed method RPC client
 * - `platform` — file upload actions
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
 * // Upload a file
 * const url = await platform.uploadFile(file);
 *
 * // Display user info
 * console.log(auth.name, auth.profilePictureUrl);
 * ```
 */

export { createClient, type InvokeOptions } from './client.js';
export { platform, type UploadFileOptions } from './platform.js';
export { auth, type AuthContext } from './auth.js';
export { MindStudioInterfaceError } from './errors.js';
export type { BootstrapConfig, BootstrapUser } from './types.js';
