/**
 * @mindstudio-ai/interface — Frontend SDK for MindStudio v2 app interfaces.
 *
 * Provides typed RPC to backend methods, file uploads, current user
 * context, and agent chat conversations. Runs inside web interfaces
 * with credentials injected by the platform via `window.__MINDSTUDIO__`.
 *
 * ## Four exports
 *
 * - `createClient()` — typed method RPC client
 * - `createAgentChatClient()` — thread-based agent conversations
 * - `platform` — file upload actions
 * - `auth` — current user identity (display only)
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
 * // Call backend methods
 * const dashboard = await api.getDashboard();
 *
 * // Agent chat with streaming
 * const thread = await chat.createThread();
 * await chat.sendMessage(thread.id, 'Hello!', {
 *   onText: (text) => console.log(text),
 * });
 *
 * // Upload a file
 * const url = await platform.uploadFile(file);
 *
 * // Display user info
 * console.log(auth.name, auth.profilePictureUrl);
 * ```
 */

export { createClient, type InvokeOptions } from './client.js';
export {
  createAgentChatClient,
  type AgentChatClient,
  type AgentChatEvent,
  type SendMessageCallbacks,
  type SendMessageResult,
  type AbortablePromise,
  type Thread,
  type ThreadSummary,
  type ThreadListPage,
  type Message,
} from './agent-chat.js';
export { platform, type UploadFileOptions } from './platform.js';
export { auth, type AuthContext } from './auth.js';
export { MindStudioInterfaceError } from './errors.js';
export type { BootstrapConfig, BootstrapUser } from './types.js';
