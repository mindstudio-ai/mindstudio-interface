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
 *   ├─ POST /_/methods/submit-vendor-request/invoke
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
 * ## Streaming
 *
 * Methods can optionally stream LLM token output via SSE. Pass
 * `{ stream: true }` as the second argument along with an `onToken`
 * callback to receive incremental updates:
 *
 * ```ts
 * const result = await api.submitVendorRequest({ name: 'Acme' }, {
 *   stream: true,
 *   onToken: (text) => setResponseText(text),
 * });
 * ```
 *
 * **Important:** The `text` value passed to `onToken` is the accumulated
 * response so far (not a delta). Replace your display content each time —
 * do not append. See {@link InvokeOptions.onToken} for details.
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
 * Options for method invocation. Pass as the optional second argument to
 * any method on the client returned by {@link createClient}.
 *
 * When `stream` is `true`, the SDK sends `{ stream: true }` in the request
 * body and parses the response as an SSE (Server-Sent Events) stream.
 * Three event types are handled:
 *
 * | SSE `type` | Payload field | SDK action |
 * |------------|---------------|------------|
 * | `token`    | `text`        | Calls {@link onToken} with accumulated text |
 * | `error`    | `error`       | Calls {@link onStreamError} with the message |
 * | `done`     | `output`      | Captures as the method's return value |
 *
 * The method's `Promise` resolves with the final `output` from the `done`
 * event — the same shape you'd get without streaming.
 */
export interface InvokeOptions {
  /**
   * Enable SSE streaming for LLM token output.
   *
   * When `true`, the request body includes `{ stream: true }` and the
   * response is parsed as an SSE stream instead of a single JSON payload.
   * The method still returns a `Promise` that resolves with the final
   * output once the stream completes.
   *
   * @default false
   */
  stream?: boolean;

  /**
   * Called with the accumulated response text each time a new token arrives.
   *
   * **Important:** `text` is the full response so far, not a delta/chunk.
   * Your frontend should **replace** (not append to) its display content
   * with this value each time the callback fires.
   *
   * This design avoids edge cases where the platform sanitizes or
   * reformats JSON mid-stream, causing earlier portions of the text to
   * change between tokens.
   *
   * @example
   * ```ts
   * const result = await api.generate({ prompt: 'Hello' }, {
   *   stream: true,
   *   onToken: (text) => {
   *     // Replace — do NOT append
   *     responseElement.textContent = text;
   *   },
   * });
   * ```
   */
  onToken?: (text: string) => void;

  /**
   * Called if a stream-level error event arrives.
   *
   * If the stream then closes without a `done` event, the method rejects
   * with a `MindStudioInterfaceError` containing the error message (code
   * `method_error`). If a `done` event does arrive after the error, the
   * method resolves with the final output — in that case this callback
   * is just for logging or showing a transient warning.
   *
   * If the stream ends without either a `done` or `error` event, the
   * method rejects with `stream_incomplete`.
   */
  onStreamError?: (error: string) => void;
}

/**
 * Default client type when no generic parameter is provided.
 * Every property returns an async function accepting optional input
 * and optional {@link InvokeOptions} for streaming.
 */
type DefaultMethodClient = Record<
  string,
  (input?: Record<string, unknown>, options?: InvokeOptions) => Promise<unknown>
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
 *
 * // Stream LLM output — onToken receives accumulated text (replace, don't append)
 * const streamed = await api.submitVendorRequest({ name: 'Acme' }, {
 *   stream: true,
 *   onToken: (text) => setResponseText(text),
 * });
 * // `streamed` is the same final output you'd get without streaming
 * ```
 */
export function createClient<T = DefaultMethodClient>(): T {
  return new Proxy({} as Record<string, unknown> as T & object, {
    get(_, methodName: string) {
      return async (input?: unknown, options?: InvokeOptions) => {
        const config = getConfig();

        const methodId = config.methods[methodName];
        if (!methodId) {
          throw new MindStudioInterfaceError(
            `Method "${methodName}" not found. Available methods: ${Object.keys(config.methods).join(', ') || '(none)'}`,
            'method_not_found',
          );
        }

        const url = `/_/methods/${methodId}/invoke`;
        const wantsStream = options?.stream === true;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            input: input ?? {},
            ...(wantsStream && { stream: true }),
          }),
        });

        if (!res.ok) {
          let errorMessage = `Method "${methodName}" failed: ${res.status} ${res.statusText}`;
          let errorCode = 'method_error';
          try {
            const body = (await res.json()) as {
              error?: string;
              code?: string;
            };
            if (body.error) {
              errorMessage = body.error;
            }
            if (body.code) {
              errorCode = body.code;
            }
          } catch {
            // Response wasn't JSON — use the default message
          }
          throw new MindStudioInterfaceError(
            errorMessage,
            errorCode,
            res.status,
          );
        }

        // Non-streaming: unchanged behavior
        if (!wantsStream) {
          const body = (await res.json()) as { output?: unknown };
          return body.output;
        }

        // Streaming: parse SSE events from response body
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalOutput: unknown;
        let streamError: string | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              continue;
            }
            const json = line.slice(6);
            try {
              const event = JSON.parse(json) as {
                type: string;
                text?: string;
                error?: string;
                output?: unknown;
              };

              if (event.type === 'token' && options?.onToken && event.text) {
                options.onToken(event.text);
              } else if (event.type === 'error' && event.error) {
                streamError = event.error;
                if (options?.onStreamError) {
                  options.onStreamError(event.error);
                }
              } else if (event.type === 'done') {
                finalOutput = event.output;
              }
            } catch {
              // Skip malformed SSE lines
            }
          }
        }

        // If the stream errored and didn't produce a final output,
        // surface the error message from the error event.
        if (finalOutput === undefined && streamError !== undefined) {
          throw new MindStudioInterfaceError(streamError, 'method_error');
        }

        if (finalOutput === undefined) {
          throw new MindStudioInterfaceError(
            'Stream ended without a done event',
            'stream_incomplete',
          );
        }

        return finalOutput;
      };
    },
  });
}
