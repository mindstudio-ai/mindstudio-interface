/**
 * Route RPC client — typed function calls to backend routes.
 *
 * `createClient()` returns a Proxy where every property access creates
 * an async function that invokes the corresponding backend route via HTTP.
 * The method name matches the route's `export` field in `app.json`.
 *
 * ## How it works
 *
 * ```
 * api.submitVendorRequest({ name: 'Acme' })
 *   │
 *   ├─ Look up route ID: config.routes["submitVendorRequest"]
 *   │  → "submit-vendor-request"
 *   │
 *   ├─ POST {apiBaseUrl}/_internal/v2/apps/{appId}/routes/submit-vendor-request/invoke
 *   │  Authorization: Bearer {session token}
 *   │  Body: { input: { name: "Acme" } }
 *   │
 *   └─ Returns response.output (or throws on error)
 * ```
 *
 * The route registry (export name → route ID mapping) is embedded in
 * `window.__MINDSTUDIO__.routes` at page load time — no extra HTTP call
 * needed to discover routes.
 *
 * ## Type safety
 *
 * Since the frontend and backend live in the same project, you can import
 * route types directly:
 *
 * ```ts
 * import type { SubmitVendorInput, SubmitVendorOutput }
 *   from '../../backend/src/submitVendorRequest';
 *
 * interface AppRoutes {
 *   submitVendorRequest(input: SubmitVendorInput): Promise<SubmitVendorOutput>;
 *   getDashboard(): Promise<GetDashboardOutput>;
 * }
 *
 * const api = createClient<AppRoutes>();
 * const result = await api.submitVendorRequest({ name: 'Acme' }); // fully typed
 * ```
 *
 * If no type parameter is provided, methods accept `any` input and return `any`.
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';

/**
 * Default client type when no generic parameter is provided.
 * Every property returns an async function accepting optional input.
 */
type DefaultRouteClient = Record<
  string,
  (input?: Record<string, unknown>) => Promise<unknown>
>;

/**
 * Create a typed RPC client for calling backend routes.
 *
 * @typeParam T - Optional interface mapping method names to their signatures.
 *   If omitted, all methods accept `any` and return `Promise<any>`.
 *
 * @returns A Proxy object where each property is an async function that
 *   invokes the corresponding backend route.
 *
 * @example
 * ```ts
 * import { createClient } from '@mindstudio-ai/interface';
 *
 * const api = createClient();
 *
 * // Each method maps to a backend route export
 * const result = await api.submitVendorRequest({ name: 'Acme' });
 * const dashboard = await api.getDashboard();
 * ```
 */
export function createClient<T = DefaultRouteClient>(): T {
  return new Proxy({} as Record<string, unknown> as T & object, {
    get(_, methodName: string) {
      // Return an async function that invokes the route
      return async (input?: unknown) => {
        const config = getConfig();

        // Look up the route ID from the embedded registry
        const routeId = config.routes[methodName];
        if (!routeId) {
          throw new MindStudioInterfaceError(
            `Route "${methodName}" not found. Available routes: ${Object.keys(config.routes).join(', ') || '(none)'}`,
            'route_not_found',
          );
        }

        // Invoke the route via HTTP
        const url = `${config.apiBaseUrl}/_internal/v2/apps/${config.appId}/routes/${routeId}/invoke`;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ input: input ?? {} }),
        });

        if (!res.ok) {
          let errorMessage = `Route "${methodName}" failed: ${res.status} ${res.statusText}`;
          let errorCode = 'route_error';

          try {
            const body = (await res.json()) as {
              error?: string;
              code?: string;
            };
            if (body.error) errorMessage = body.error;
            if (body.code) errorCode = body.code;
          } catch {
            // Response wasn't JSON — use the default message
          }

          throw new MindStudioInterfaceError(errorMessage, errorCode, res.status);
        }

        const body = (await res.json()) as { output?: unknown };
        return body.output;
      };
    },
  });
}
