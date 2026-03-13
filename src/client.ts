/**
 * Method RPC client — typed function calls to backend methods.
 *
 * `createClient()` returns a Proxy where every property access creates
 * an async function that invokes the corresponding backend method via HTTP.
 * The method name matches the method's `export` field in `app.json`.
 *
 * ## How it works
 *
 * ```
 * api.submitVendorRequest({ name: 'Acme' })
 *   │
 *   ├─ Look up method ID: config.methods["submitVendorRequest"]
 *   │  → "submit-vendor-request"
 *   │
 *   ├─ POST {apiBaseUrl}/_internal/v2/apps/{appId}/methods/submit-vendor-request/invoke
 *   │  Authorization: Bearer {session token}
 *   │  Body: { input: { name: "Acme" } }
 *   │
 *   └─ Returns response.output (or throws on error)
 * ```
 *
 * The method registry (export name → method ID mapping) is embedded in
 * `window.__MINDSTUDIO__.methods` at page load time — no extra HTTP call
 * needed to discover methods.
 *
 * ## Type safety
 *
 * Since the frontend and backend live in the same project, you can import
 * types directly:
 *
 * ```ts
 * import type { SubmitVendorInput, SubmitVendorOutput }
 *   from '../../backend/src/submitVendorRequest';
 *
 * interface AppMethods {
 *   submitVendorRequest(input: SubmitVendorInput): Promise<SubmitVendorOutput>;
 *   getDashboard(): Promise<GetDashboardOutput>;
 * }
 *
 * const api = createClient<AppMethods>();
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
type DefaultMethodClient = Record<
  string,
  (input?: Record<string, unknown>) => Promise<unknown>
>;

/**
 * Create a typed RPC client for calling backend methods.
 *
 * @typeParam T - Optional interface mapping method names to their signatures.
 *   If omitted, all methods accept `any` and return `Promise<any>`.
 *
 * @returns A Proxy object where each property is an async function that
 *   invokes the corresponding backend method.
 *
 * @example
 * ```ts
 * import { createClient } from '@mindstudio-ai/interface';
 *
 * const api = createClient();
 *
 * // Each method maps to a backend method export
 * const result = await api.submitVendorRequest({ name: 'Acme' });
 * const dashboard = await api.getDashboard();
 * ```
 */
export function createClient<T = DefaultMethodClient>(): T {
  return new Proxy({} as Record<string, unknown> as T & object, {
    get(_, methodName: string) {
      // Return an async function that invokes the method
      return async (input?: unknown) => {
        const config = getConfig();

        // Look up the method ID from the embedded registry
        const methodId = config.methods[methodName];
        if (!methodId) {
          throw new MindStudioInterfaceError(
            `Method "${methodName}" not found. Available methods: ${Object.keys(config.methods).join(', ') || '(none)'}`,
            'method_not_found',
          );
        }

        // Invoke the method via HTTP
        const url = `${config.apiBaseUrl}/_internal/v2/apps/${config.appId}/methods/${methodId}/invoke`;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ input: input ?? {} }),
        });

        if (!res.ok) {
          let errorMessage = `Method "${methodName}" failed: ${res.status} ${res.statusText}`;
          let errorCode = 'method_error';

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
