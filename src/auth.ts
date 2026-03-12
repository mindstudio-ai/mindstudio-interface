/**
 * Auth context — current user's identity for display purposes.
 *
 * Provides synchronous access to the current user's name, email, and
 * profile picture. Hydrated from the bootstrap globals injected by the
 * platform — no HTTP call needed.
 *
 * This is for **display only**. Role checking, permission enforcement,
 * and user lookups for other users are backend concerns — the frontend
 * calls backend routes that handle those via `@mindstudio-ai/agent`'s
 * `auth` namespace.
 *
 * @example
 * ```ts
 * import { auth } from '@mindstudio-ai/interface';
 *
 * return (
 *   <div>
 *     <p>Welcome, {auth.name}</p>
 *     <img src={auth.profilePictureUrl} />
 *   </div>
 * );
 * ```
 */

import { getConfig } from './config.js';

/**
 * User identity context. All properties are read-only and synchronous.
 */
export interface AuthContext {
  /** Current user's ID (UUID). */
  readonly userId: string;

  /** Current user's display name. */
  readonly name: string;

  /** Current user's email address. */
  readonly email: string;

  /** Current user's profile picture URL, or null if not set. */
  readonly profilePictureUrl: string | null;
}

/**
 * Lazy auth proxy — reads from bootstrap globals on first property access.
 *
 * Using a Proxy lets us export `auth` as a module-level constant while
 * deferring the `getConfig()` call until the first property is accessed.
 * This avoids throwing during import if the page hasn't finished loading
 * the bootstrap script yet.
 */
export const auth: AuthContext = new Proxy({} as AuthContext, {
  get(_, prop: string) {
    const { user } = getConfig();

    switch (prop) {
      case 'userId':
        return user.id;
      case 'name':
        return user.name;
      case 'email':
        return user.email;
      case 'profilePictureUrl':
        return user.profilePictureUrl ?? null;
      default:
        return undefined;
    }
  },
});
