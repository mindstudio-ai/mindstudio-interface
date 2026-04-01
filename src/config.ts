/**
 * Bootstrap configuration reader.
 *
 * Reads and validates `window.__MINDSTUDIO__` — the globals injected by
 * the platform before the app's JavaScript runs. The result is cached
 * after first read.
 *
 * All other modules in the SDK call `getConfig()` internally. App code
 * should never need to call this directly — use `createClient()`, `auth`,
 * and `platform` instead.
 */

import { MindStudioInterfaceError } from './errors.js';
import type { AppUser, BootstrapConfig } from './types.js';

let _config: BootstrapConfig | undefined;

/**
 * Read and validate the bootstrap configuration from `window.__MINDSTUDIO__`.
 *
 * Caches the result after first successful read. Throws if the globals
 * are missing or incomplete — this means the page isn't running inside
 * the MindStudio platform.
 *
 * @returns The validated bootstrap config
 * @throws {MindStudioInterfaceError} if `window.__MINDSTUDIO__` is missing or invalid
 */
export function getConfig(): BootstrapConfig {
  if (_config) {
    return _config;
  }

  const raw = (globalThis as Record<string, unknown>).__MINDSTUDIO__ as
    | Partial<BootstrapConfig>
    | undefined;

  if (!raw) {
    throw new MindStudioInterfaceError(
      '@mindstudio-ai/interface requires the MindStudio platform context. ' +
        'This page must be loaded inside MindStudio (window.__MINDSTUDIO__ is missing).',
      'not_initialized',
    );
  }

  // Validate required fields (user can be null for unauthenticated sessions)
  if (!raw.token || !raw.releaseId || !raw.methods) {
    const missing = ['token', 'releaseId', 'methods']
      .filter((k) => !raw[k as keyof BootstrapConfig])
      .join(', ');

    throw new MindStudioInterfaceError(
      `MindStudio platform context is incomplete. Missing: ${missing}`,
      'invalid_config',
    );
  }

  _config = raw as BootstrapConfig;
  return _config;
}

/**
 * Update the cached config in-place after an auth state transition.
 *
 * The cached config is a mutable reference — all SDK modules read it
 * on-demand via `getConfig()`, so mutations propagate immediately to
 * method invocation, agent chat, uploads, etc.
 *
 * @internal Not exported from the package — used by the auth module only.
 */
export function updateConfig(updates: {
  token?: string;
  user?: AppUser | null;
  methods?: Record<string, string>;
}): void {
  const config = getConfig();
  if (updates.token !== undefined) {
    config.token = updates.token;
  }
  if (updates.user !== undefined) {
    config.user = updates.user;
  }
  if (updates.methods !== undefined) {
    config.methods = updates.methods;
  }
}
