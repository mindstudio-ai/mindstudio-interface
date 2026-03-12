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
import type { BootstrapConfig } from './types.js';

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
  if (_config) return _config;

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

  // Validate required fields
  if (!raw.token || !raw.appId || !raw.releaseId || !raw.apiBaseUrl || !raw.user || !raw.routes) {
    const missing = ['token', 'appId', 'releaseId', 'apiBaseUrl', 'user', 'routes']
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
