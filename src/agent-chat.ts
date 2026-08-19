/**
 * Agent chat client — thread-based conversations with AI agents.
 *
 * `createAgentChatClient()` returns an object with methods for thread
 * lifecycle (create, list, get, rename, delete) and message streaming.
 * The agent runs server-side with access to the app's methods as tools.
 *
 * ## How it works
 *
 * ```
 * chat.sendMessage(threadId, 'Help me prep for my review', {
 *   onText: (delta) => setAssistantMessage((prev) => prev + delta),
 * })
 *   │
 *   ├─ POST /_/agent/threads/{threadId}/messages
 *   │  Authorization: Bearer {session token}
 *   │  Body: { content: "Help me prep for my review" }
 *   │
 *   ├─ Response: SSE stream
 *   │  data: {"type":"text","text":"I'll create...","ts":1711...}
 *   │  data: {"type":"tool_call_start","id":"call_abc","name":"create-todo","ts":1711...}
 *   │  data: {"type":"tool_call_result","id":"call_abc","output":{...},"ts":1711...}
 *   │  data: {"type":"text","text":"Done — added it.","ts":1711...}
 *   │  data: {"type":"done","stopReason":"end_turn","usage":{...},"ts":1711...}
 *   │
 *   └─ Promise resolves with { stopReason, usage }
 * ```
 *
 * ## Stateless design
 *
 * This client is a thin wrapper over HTTP endpoints. It does not manage
 * local state — your React/framework layer owns the thread list, message
 * array, and UI state. Each method is an independent request.
 *
 * ## Streaming callbacks
 *
 * `sendMessage` accepts named callbacks for common events (onText,
 * onThinking, onToolCallStart, etc.) plus a catch-all `onEvent` that
 * receives every SSE event as a discriminated union. Both fire for the
 * same event — use named callbacks for convenience, `onEvent` for
 * logging or handling low-level events like `tool_use` and
 * `tool_input_delta`.
 *
 * @example
 * ```ts
 * import { createAgentChatClient } from '@mindstudio-ai/interface';
 *
 * const chat = createAgentChatClient();
 *
 * // Thread lifecycle
 * const thread = await chat.createThread();
 * const { threads } = await chat.listThreads();
 * const full = await chat.getThread(thread.id);
 *
 * // Send a message with streaming
 * const response = chat.sendMessage(thread.id, 'Hello!', {
 *   onText: (delta) => setMessage((prev) => prev + delta),
 *   onToolCallStart: (id, name) => showToolSpinner(name),
 *   onToolCallResult: (id, output) => showToolResult(output),
 * });
 *
 * const { stopReason, usage } = await response;
 *
 * // Abort mid-stream
 * response.abort();
 * ```
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';

// ---------------------------------------------------------------------------
// Thread types
// ---------------------------------------------------------------------------

/** Thread summary returned from create and list endpoints. */
export interface ThreadSummary {
  /** Thread ID (UUID). */
  id: string;
  /** User-editable title, auto-generated on first message. */
  title: string | null;
  /** ISO 8601 creation timestamp. */
  dateCreated: string;
  /** ISO 8601 last-updated timestamp. */
  dateUpdated: string;
}

/** Full thread with message history, returned from get endpoint. */
export interface Thread {
  /** Thread ID (UUID). */
  id: string;
  /** User-editable title. */
  title: string | null;
  /** Full conversation history. */
  messages: Message[];
  /** ISO 8601 creation timestamp. */
  dateCreated: string;
  /** ISO 8601 last-updated timestamp. */
  dateUpdated: string;
}

/** A tool call requested by the assistant. */
export interface ToolCall {
  /** Tool call ID, used to match results. */
  id: string;
  /** Method name. */
  name: string;
  /** Input arguments. */
  input: Record<string, unknown>;
}

/** A single message in a thread's conversation history. */
export interface Message {
  /** `"user"` for human messages, `"assistant"` for agent responses. */
  role: 'user' | 'assistant';
  /** Message text content. For tool results, this is JSON-stringified output. */
  content: string;
  /**
   * MindStudio CDN URLs attached to this message (user messages only).
   *
   * Images (`i.mscdn.ai`) are sent to the model as vision input.
   * Documents (`f.mscdn.ai`, `files.mindstudio-cdn.com`) have their text
   * extracted server-side and included in the model context. The original
   * URLs are preserved in thread history for the frontend to render.
   */
  attachments?: string[];
  /** Tool calls the assistant requested (assistant messages only). */
  toolCalls?: ToolCall[];
  /** ID of the tool call this message is a result for (tool result messages only). */
  toolCallId?: string;
  /** Whether this tool result represents an error. */
  isToolError?: boolean;
}

/** Paginated thread list response. */
export interface ThreadListPage {
  /** Threads for this page. */
  threads: ThreadSummary[];
  /** Cursor for the next page, or `null` if this is the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

/** Assistant text delta — append to your display string, do not replace. */
export interface AgentTextEvent {
  type: 'text';
  text: string;
  ts: number;
}

/** Model thinking text (extended thinking). */
export interface AgentThinkingEvent {
  type: 'thinking';
  text: string;
  ts: number;
}

/** Thinking complete with full text and signature. */
export interface AgentThinkingCompleteEvent {
  type: 'thinking_complete';
  thinking: string;
  signature: string;
  ts: number;
}

/** Model requested a tool call (includes parsed input). */
export interface AgentToolUseEvent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  ts: number;
}

/** Streaming delta for tool call input JSON. */
export interface AgentToolInputDeltaEvent {
  type: 'tool_input_delta';
  id: string;
  name: string;
  delta: string;
  ts: number;
}

/** Agent began executing a tool call. */
export interface AgentToolCallStartEvent {
  type: 'tool_call_start';
  id: string;
  name: string;
  ts: number;
}

/** Tool call returned a result. */
export interface AgentToolCallResultEvent {
  type: 'tool_call_result';
  id: string;
  output: unknown;
  ts: number;
}

/**
 * The agent invoked a client tool (agent.md `target: "client"`) — an action
 * that happens in this browser (open a sheet, navigate, highlight). Handle it
 * via `onClientToolCall`. Fire-and-forget: the agent continues immediately
 * with an acknowledgment; your next message closes the loop.
 */
export interface AgentClientToolCallEvent {
  type: 'client_tool_call';
  id: string;
  name: string;
  input: unknown;
  ts: number;
}

/** Stream complete. */
export interface AgentDoneEvent {
  type: 'done';
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  ts: number;
}

/** Stream-level error. */
export interface AgentErrorEvent {
  type: 'error';
  error: string;
  ts: number;
}

/** Discriminated union of all SSE events from the agent chat stream. */
export type AgentChatEvent =
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentThinkingCompleteEvent
  | AgentToolUseEvent
  | AgentToolInputDeltaEvent
  | AgentToolCallStartEvent
  | AgentToolCallResultEvent
  | AgentClientToolCallEvent
  | AgentDoneEvent
  | AgentErrorEvent;

// ---------------------------------------------------------------------------
// Callbacks and result types
// ---------------------------------------------------------------------------

/**
 * Callbacks for `sendMessage` streaming.
 *
 * Named callbacks fire for common events. The catch-all `onEvent` fires
 * for every event including those with named callbacks — use it for
 * logging or handling low-level events like `tool_use` and
 * `tool_input_delta`.
 */
export interface SendMessageCallbacks {
  /**
   * Called with each text delta as the assistant responds.
   *
   * **Important:** `text` is a delta (new chunk), not the accumulated
   * response. Append it to your display string — do not replace.
   *
   * @example
   * ```ts
   * onText: (delta) => setMessage((prev) => prev + delta)
   * ```
   */
  onText?: (text: string) => void;

  /** Called with model thinking text (extended thinking). */
  onThinking?: (text: string) => void;

  /** Called when thinking is complete. */
  onThinkingComplete?: (thinking: string, signature: string) => void;

  /** Called when a tool call begins executing. */
  onToolCallStart?: (id: string, name: string) => void;

  /** Called when a tool call produces a result. */
  onToolCallResult?: (id: string, output: unknown) => void;

  /**
   * Called when the agent invokes a client tool (agent.md `target:
   * "client"`) — run the on-screen action here. Fire-and-forget: the agent
   * has already been told the action was displayed.
   */
  onClientToolCall?: (name: string, input: unknown, id: string) => void;

  /** Called on a stream-level error event. */
  onError?: (error: string) => void;

  /** Called for every SSE event (including ones with named callbacks). */
  onEvent?: (event: AgentChatEvent) => void;

  /** AbortSignal to cancel the stream. */
  signal?: AbortSignal;
}

/** Options for `sendMessage`. */
export interface SendMessageOptions {
  /**
   * MindStudio CDN URLs to attach to the message.
   *
   * Images are sent to the model as vision input (one per message).
   * Documents have their text extracted server-side and included in context.
   *
   * Upload files first via {@link platform.upload} (with a backend-minted
   * upload token) and pass the returned URLs.
   *
   * @example
   * ```ts
   * const token = await api.getUploadSlot({ contentType: file.type });
   * const { url } = await platform.upload(token, file);
   * chat.sendMessage(threadId, 'What is this?', callbacks, {
   *   attachments: [url],
   * });
   * ```
   */
  attachments?: string[];
}

/** Resolved value of `sendMessage` — extracted from the `done` event. */
export interface SendMessageResult {
  /** Why the agent stopped (`"end_turn"`, `"max_tokens"`, etc.). */
  stopReason: string;
  /** Token usage for the full agent loop. */
  usage: { inputTokens: number; outputTokens: number };
}

/** A Promise with an `abort()` method for cancelling the stream. */
export type AbortablePromise<T> = Promise<T> & {
  /** Cancel the in-flight stream. The promise rejects with `AbortError`. */
  abort: () => void;
};

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

/** Agent chat client returned by {@link createAgentChatClient}. */
export interface AgentChatClient {
  /** Create a new conversation thread. */
  createThread(): Promise<ThreadSummary>;

  /** List threads with cursor-based pagination (50 per page). */
  listThreads(cursor?: string): Promise<ThreadListPage>;

  /** Get a thread with its full message history. */
  getThread(threadId: string): Promise<Thread>;

  /** Update a thread's title. */
  updateThread(threadId: string, title: string): Promise<void>;

  /** Delete a thread (soft delete). */
  deleteThread(threadId: string): Promise<void>;

  /**
   * Claim an anonymous thread after in-app verification (progressive auth).
   * Login replaces the app's session token, which makes threads started
   * anonymously unreachable — claiming re-binds the thread to the signed-in
   * user so the conversation survives the login. Call it right after your
   * verification succeeds, for each anonymous thread you want to keep.
   *
   * Ownership is proven with the token the thread was created/used under:
   * the client remembers it automatically for threads touched in this page
   * session; pass `previousToken` explicitly for threads from an earlier
   * page load (e.g. a token you persisted before login).
   * Rejects with `already_identified` if the thread already has an owner.
   */
  claimThread(
    threadId: string,
    options?: { previousToken?: string },
  ): Promise<void>;

  /**
   * Send a message and stream the agent's response.
   *
   * Returns an {@link AbortablePromise} that resolves with
   * `{ stopReason, usage }` when the stream completes. Call `.abort()`
   * on the returned promise to cancel mid-stream.
   *
   * @param options.attachments - URLs to attach.
   *   Images are sent as vision input.
   *   Documents have text extracted into context.
   *   Upload files first via {@link platform.upload} and pass the returned URLs.
   */
  sendMessage(
    threadId: string,
    content: string,
    callbacks?: SendMessageCallbacks,
    options?: SendMessageOptions,
  ): AbortablePromise<SendMessageResult>;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const AGENT_BASE = '/_/agent';

async function request<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const config = getConfig();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${AGENT_BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    let errorMessage = `Agent chat request failed: ${res.status} ${res.statusText}`;
    let errorCode = 'agent_chat_error';
    try {
      const err = (await res.json()) as { error?: string; code?: string };
      if (err.error) {
        errorMessage = err.error;
      }
      if (err.code) {
        errorCode = err.code;
      }
    } catch {
      // Response wasn't JSON — use the default message
    }
    throw new MindStudioInterfaceError(errorMessage, errorCode, res.status);
  }

  return (await res.json()) as T;
}

function dispatchEvent(
  event: AgentChatEvent,
  callbacks: SendMessageCallbacks,
): void {
  // Catch-all fires for every event
  callbacks.onEvent?.(event);

  // Named callbacks
  switch (event.type) {
    case 'text':
      callbacks.onText?.(event.text);
      break;
    case 'thinking':
      callbacks.onThinking?.(event.text);
      break;
    case 'thinking_complete':
      callbacks.onThinkingComplete?.(event.thinking, event.signature);
      break;
    case 'tool_call_start':
      callbacks.onToolCallStart?.(event.id, event.name);
      break;
    case 'tool_call_result':
      callbacks.onToolCallResult?.(event.id, event.output);
      break;
    case 'client_tool_call':
      callbacks.onClientToolCall?.(event.name, event.input, event.id);
      break;
    case 'error':
      callbacks.onError?.(event.error);
      break;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an agent chat client for thread-based conversations.
 *
 * The client is stateless — each method is an independent HTTP request.
 * Your application layer owns thread state, message arrays, and UI updates.
 *
 * @returns An {@link AgentChatClient} with methods for thread CRUD and
 *   message streaming.
 *
 * @example
 * ```ts
 * import { createAgentChatClient } from '@mindstudio-ai/interface';
 *
 * const chat = createAgentChatClient();
 *
 * const thread = await chat.createThread();
 *
 * const response = chat.sendMessage(thread.id, 'Hello!', {
 *   onText: (delta) => setAssistantMessage((prev) => prev + delta),
 *   onToolCallStart: (id, name) => showToolSpinner(name),
 *   onToolCallResult: (id, output) => showToolResult(output),
 * });
 *
 * const { stopReason, usage } = await response;
 * ```
 */
export function createAgentChatClient(): AgentChatClient {
  // Mint-time bearer per thread, for claimThread's ownership proof — after an
  // in-app login the app's config token is REPLACED (a fresh interface
  // session), so the pre-login token must be remembered to claim with.
  const threadTokens = new Map<string, string>();
  const rememberToken = (threadId: string) => {
    const token = getConfig().token;
    if (token && !threadTokens.has(threadId)) {
      threadTokens.set(threadId, token);
    }
  };

  return {
    async createThread() {
      const token = getConfig().token;
      const thread = await request<ThreadSummary>('/threads', 'POST');
      if (token) {
        threadTokens.set(thread.id, token);
      }
      return thread;
    },

    listThreads(cursor?: string) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request<ThreadListPage>(`/threads${query}`, 'GET');
    },

    getThread(threadId: string) {
      return request<Thread>(`/threads/${threadId}`, 'GET');
    },

    async updateThread(threadId: string, title: string) {
      await request(`/threads/${threadId}`, 'PATCH', { title });
    },

    async deleteThread(threadId: string) {
      await request(`/threads/${threadId}`, 'DELETE');
    },

    async claimThread(threadId: string, options?: { previousToken?: string }) {
      const previousToken =
        options?.previousToken ?? threadTokens.get(threadId);
      if (!previousToken) {
        throw new MindStudioInterfaceError(
          'No pre-login token known for this thread — pass options.previousToken.',
          'missing_previous_token',
          400,
        );
      }
      await request(`/threads/${threadId}/claim`, 'POST', { previousToken });
      threadTokens.delete(threadId);
    },

    sendMessage(
      threadId: string,
      content: string,
      callbacks?: SendMessageCallbacks,
      options?: SendMessageOptions,
    ): AbortablePromise<SendMessageResult> {
      rememberToken(threadId);
      const controller = new AbortController();
      const cb = callbacks ?? {};

      // Wire caller's signal to our internal controller
      if (cb.signal) {
        if (cb.signal.aborted) {
          controller.abort();
        } else {
          cb.signal.addEventListener('abort', () => controller.abort(), {
            once: true,
          });
        }
      }

      const promise = (async (): Promise<SendMessageResult> => {
        const config = getConfig();
        const url = `${AGENT_BASE}/threads/${threadId}/messages`;

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            content,
            ...(options?.attachments?.length && {
              attachments: options.attachments,
            }),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let errorMessage = `Send message failed: ${res.status} ${res.statusText}`;
          let errorCode = 'agent_chat_error';
          try {
            const err = (await res.json()) as {
              error?: string;
              code?: string;
            };
            if (err.error) {
              errorMessage = err.error;
            }
            if (err.code) {
              errorCode = err.code;
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

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result: SendMessageResult | undefined;

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
              const event = JSON.parse(json) as AgentChatEvent;

              if (event.type === 'done') {
                result = {
                  stopReason: event.stopReason,
                  usage: event.usage,
                };
              }

              dispatchEvent(event, cb);
            } catch {
              // Skip malformed SSE lines
            }
          }
        }

        if (!result) {
          throw new MindStudioInterfaceError(
            'Stream ended without a done event',
            'stream_incomplete',
          );
        }

        return result;
      })();

      const abortable = promise as AbortablePromise<SendMessageResult>;
      abortable.abort = () => controller.abort();
      return abortable;
    },
  };
}
