/**
 * Voice client for apps with a voice interface.
 *
 * Imported from the `./voice` subpath so apps that never use voice ship none
 * of it — and `livekit-client` (the one dependency, for the realtime media
 * transport) is loaded dynamically on the first `startSession()` call:
 *
 * ```
 * import { createVoiceClient } from '@mindstudio-ai/interface/voice';
 * ```
 *
 * Flow: `startSession()` mints a session from the platform
 * (`POST /_/voice/sessions`), connects to the media room, publishes the
 * microphone, and returns a {@link VoiceSession} that surfaces the
 * conversation as events — agent state, live captions for both sides, tool
 * activity — plus mute / text-injection / end controls. Agent audio playback
 * is handled internally (a hidden autoplaying element); the app never touches
 * audio elements.
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';
import type { Room, RemoteTrack, TextStreamReader } from 'livekit-client';

// ---------------------------------------------------------------------------
// Wire constants (the voice worker's room contract)
// ---------------------------------------------------------------------------

const VOICE_BASE = '/_/voice';

/** Live captions, published by the agent framework. */
const TOPIC_TRANSCRIPTION = 'lk.transcription';
/** Text input into the live conversation (interrupts + replies). */
const TOPIC_CHAT = 'lk.chat';
/** Tool activity, published by the MindStudio voice worker. */
const TOPIC_TOOL = 'ms.voice.tool';
const TOPIC_CLIENT_TOOL = 'ms.voice.client-tool';
const TOPIC_CLIENT_TOOL_RESULT = 'ms.voice.client-tool-result';
// Client-tool handler returns must fit the same forwarding cap as tool
// results; oversize returns become an error the agent can speak around.
const CLIENT_TOOL_RESULT_MAX_CHARS = 32_000;

const ATTR_TRANSCRIPTION_FINAL = 'lk.transcription_final';
const ATTR_SEGMENT_ID = 'lk.segment_id';
const ATTR_AGENT_STATE = 'lk.agent.state';

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/** Lifecycle of a live voice session, driven by the agent's published state. */
export type VoiceSessionState =
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'ended';

/** One live-caption update. */
export interface VoiceTranscriptEvent {
  /** Whose speech this is. */
  role: 'user' | 'agent';
  /** Stable id for one utterance — updates with the same id replace, not append. */
  segmentId: string;
  /** The utterance text so far (always the full text, never a delta). */
  text: string;
  /** True once this segment won't change again. */
  final: boolean;
}

/** Tool activity from the agent, for inline status UI. */
export interface VoiceToolCallEvent {
  /** The method id being executed. */
  method: string;
  status: 'running' | 'done' | 'failed';
  /** Milliseconds since epoch. */
  at: number;
  /**
   * The tool's return value — present on every 'done' (unless truncated), so
   * the UI can render what the agent just did (a citation, a record, a
   * confirmation) in lockstep with speech. Delivered only to this session's
   * room — the same security context as the invocation. Failed calls carry
   * no result.
   */
  result?: unknown;
  /** Set instead of `result` when the payload exceeded the forwarding size
   * cap (~32KB serialized) — fetch the data yourself in that case. */
  resultTruncated?: boolean;
}

export interface VoiceSessionCallbacks {
  stateChange: (state: VoiceSessionState) => void;
  transcript: (event: VoiceTranscriptEvent) => void;
  toolCall: (event: VoiceToolCallEvent) => void;
  error: (error: Error) => void;
}

export interface StartSessionOptions {
  /** Abort the connection attempt (the promise rejects with `AbortError`). */
  signal?: AbortSignal;
}

/** A live voice conversation. */
export interface VoiceSession {
  /** The platform session id (matches the call record in session history). */
  readonly sessionId: string;
  /** The media room name. */
  readonly room: string;
  /** Current session state. */
  readonly state: VoiceSessionState;
  /** Whether the microphone is currently muted. */
  readonly isMuted: boolean;

  /** Subscribe to a session event. Returns an unsubscribe function. */
  on<K extends keyof VoiceSessionCallbacks>(
    event: K,
    callback: VoiceSessionCallbacks[K],
  ): () => void;

  /** Mute the microphone (the session stays live). */
  mute(): Promise<void>;
  /** Unmute the microphone. */
  unmute(): Promise<void>;
  /**
   * Inject text into the live conversation — the agent treats it like user
   * speech (interrupts what it's saying and responds). Use for exact strings
   * that are painful aloud: addresses, codes, emails.
   */
  sendText(text: string): Promise<void>;
  /**
   * Register a handler for a client tool — a tool declared in voice.md with
   * `target: "client"`, whose effect lives in this browser (open a sheet,
   * navigate, highlight). When the agent invokes it, the handler runs and its
   * return value goes back to the agent as the tool result — a real
   * request/response, so the agent knows the action happened. Throwing (or an
   * unregistered tool) returns an error the agent speaks around; the agent
   * waits up to ~30s. One handler per tool name (later registrations
   * replace); returns an unregister function.
   */
  registerClientTool(
    name: string,
    handler: (args: unknown) => unknown | Promise<unknown>,
  ): () => void;

  /**
   * Upgrade this live session from anonymous to the now-signed-in user —
   * call it right after your in-app verification succeeds (progressive
   * auth). Subsequent tool calls run as the verified user with their roles,
   * and the agent's Current User context refreshes, WITHOUT tearing down
   * the conversation. Requires the session to have been started anonymously
   * (an already-identified session rejects with `already_identified`);
   * the SDK proves ownership with the token the session was minted under.
   * On failure, ending and restarting the session is the fallback.
   */
  refreshIdentity(): Promise<void>;
  /** End the session and release the microphone. */
  end(): Promise<void>;
}

/**
 * The active session's QA/debug handle, published on `window.__MS_VOICE__`
 * while a session is live (cleared when it ends; last session wins).
 *
 * Exists so automation that can't produce audio — the platform's browser QA
 * agent driving the app in headless Chrome — can converse with the voice
 * agent by injected text and assert on what it said and which tools ran,
 * while the app's real UI (client-tool cards, state orb, captions) renders
 * normally. It grants nothing the page's own scripts don't already have:
 * it's the same session object, in the same execution context, made
 * reachable instead of trapped in the app's closure.
 */
export interface VoiceQaHandle {
  sessionId: string;
  /** Live session state (reads through to the session). */
  readonly state: VoiceSessionState;
  /** Inject a user turn — same as `session.sendText`. */
  sendText(text: string): Promise<void>;
  /**
   * Caption history so far, one entry per segment (entries update in place as
   * a segment grows; `final` marks settled ones). Read before `end()` — the
   * handle is removed when the session ends.
   */
  transcript: VoiceTranscriptEvent[];
  /** Tool activity so far, in arrival order (`done` entries carry `result`). */
  toolCalls: VoiceToolCallEvent[];
  /** End the session — same as `session.end`. */
  end(): Promise<void>;
}

declare global {
  interface Window {
    /** Active voice session's QA/debug handle — see {@link VoiceQaHandle}. */
    __MS_VOICE__?: VoiceQaHandle;
  }
}

// Buffer bounds for the QA handle. Segments update in place, so the
// transcript cap is a count of utterances, not events; both caps exist only
// so a long-running session can't grow the page's memory unboundedly.
const QA_TRANSCRIPT_MAX_SEGMENTS = 200;
const QA_TOOL_CALLS_MAX = 100;

// ---------------------------------------------------------------------------
// Call-record types (session history)
// ---------------------------------------------------------------------------

/** A past voice session (call record), transcript excluded. */
export interface VoiceSessionSummary {
  id: string;
  status: 'active' | 'ended' | 'failed';
  startedAt: string;
  endedAt: string | null;
  durationSecs: number | null;
  endedReason: string | null;
}

/** One persisted transcript entry on a call record. */
export interface VoiceTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  interrupted?: boolean;
  /** Milliseconds since epoch. */
  at: number;
}

/** A past voice session with its transcript. */
export interface VoiceSessionDetail extends VoiceSessionSummary {
  transcript: VoiceTranscriptEntry[];
}

export interface VoiceSessionListPage {
  sessions: VoiceSessionSummary[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface VoiceClient {
  /**
   * Start a voice session: mints it from the platform, connects to the media
   * room, and publishes the microphone.
   *
   * @throws {MindStudioInterfaceError} `microphone_denied` when the user
   *   refuses microphone access, `voice_concurrency_limit` /
   *   `voice_visitor_limit` when the app's session limits are reached,
   *   `auth_required` (401) / `role_required` (403) when the interface's
   *   auth block denies the caller (route to the app's login flow),
   *   `no_voice_config` when the app has no voice interface.
   */
  startSession(options?: StartSessionOptions): Promise<VoiceSession>;

  /** List the current user's (or visitor's) past sessions, newest first. */
  listSessions(cursor?: string): Promise<VoiceSessionListPage>;

  /** Fetch one past session, transcript included. */
  getSession(sessionId: string): Promise<VoiceSessionDetail>;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

  const res = await fetch(`${VOICE_BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  if (!res.ok) {
    let errorMessage = `Voice request failed: ${res.status} ${res.statusText}`;
    let errorCode = 'voice_error';
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

type Listeners = {
  [K in keyof VoiceSessionCallbacks]: Set<VoiceSessionCallbacks[K]>;
};

function createListeners(): Listeners {
  return {
    stateChange: new Set(),
    transcript: new Set(),
    toolCall: new Set(),
    error: new Set(),
  };
}

/** Map the agent's published state onto the session's client-facing states. */
function mapAgentState(value: string): VoiceSessionState {
  switch (value) {
    case 'listening':
    case 'idle':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    default:
      return 'connecting';
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a voice client.
 *
 * @returns A {@link VoiceClient} for starting live sessions and reading past
 *   call records.
 *
 * @example
 * ```ts
 * import { createVoiceClient } from '@mindstudio-ai/interface/voice';
 *
 * const voice = createVoiceClient();
 * const session = await voice.startSession();
 *
 * session.on('stateChange', (state) => setOrbState(state));
 * session.on('transcript', ({ role, segmentId, text, final }) =>
 *   upsertCaption(segmentId, role, text, final),
 * );
 * session.on('toolCall', ({ method, status }) => showToolStatus(method, status));
 *
 * // ... later
 * await session.end();
 * ```
 */
export function createVoiceClient(): VoiceClient {
  return {
    async startSession(options?: StartSessionOptions): Promise<VoiceSession> {
      options?.signal?.throwIfAborted();

      // Snapshot the bearer this session is minted under: after an in-app
      // login the app's config token is REPLACED (a fresh interface session),
      // and refreshIdentity() must prove ownership with the original one.
      const mintTimeToken = getConfig().token;

      const minted = await request<{
        sessionId: string;
        url: string;
        token: string;
        room: string;
      }>('/sessions', 'POST');

      // The media transport loads on first use — apps that never start a
      // voice session never fetch it.
      const lk = await import('livekit-client');

      options?.signal?.throwIfAborted();

      const room: Room = new lk.Room();
      const listeners = createListeners();
      const clientToolHandlers = new Map<
        string,
        (args: unknown) => unknown | Promise<unknown>
      >();
      let state: VoiceSessionState = 'connecting';
      let muted = false;
      let audioEl: HTMLMediaElement | null = null;
      let qaHandle: VoiceQaHandle | null = null;

      const setState = (next: VoiceSessionState) => {
        if (next === state || state === 'ended') {
          return;
        }
        state = next;
        for (const cb of listeners.stateChange) {
          cb(next);
        }
      };

      const emitError = (error: Error) => {
        for (const cb of listeners.error) {
          cb(error);
        }
      };

      const cleanup = () => {
        if (audioEl) {
          audioEl.remove();
          audioEl = null;
        }
        // Only remove the QA handle if it's still ours — a newer session may
        // have replaced it already (last session wins).
        if (qaHandle && window.__MS_VOICE__ === qaHandle) {
          delete window.__MS_VOICE__;
        }
        qaHandle = null;
        setState('ended');
      };

      const isAgent = (identity: string) => {
        const participant = room.remoteParticipants.get(identity);
        return participant?.kind === lk.ParticipantKind.AGENT;
      };

      // Agent audio: attach to an SDK-managed hidden element. The agent
      // waits for this subscription before speaking.
      room.on(
        lk.RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _pub, participant) => {
          if (
            track.kind === lk.Track.Kind.Audio &&
            participant.kind === lk.ParticipantKind.AGENT
          ) {
            audioEl = track.attach();
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
          }
        },
      );

      // Session state from the agent participant's published attribute.
      room.on(
        lk.RoomEvent.ParticipantAttributesChanged,
        (_changed, participant) => {
          if (participant.kind === lk.ParticipantKind.AGENT) {
            const value = participant.attributes[ATTR_AGENT_STATE];
            if (value) {
              setState(mapAgentState(value));
            }
          }
        },
      );

      room.on(lk.RoomEvent.Disconnected, () => {
        cleanup();
      });

      // Live captions. User transcripts arrive attributed as the local
      // participant (full-replacement streams per segment, final flagged in
      // the attributes); agent transcripts are one delta stream per segment,
      // final when the stream ends.
      room.registerTextStreamHandler(
        TOPIC_TRANSCRIPTION,
        (reader: TextStreamReader, participantInfo) => {
          const role =
            participantInfo.identity === room.localParticipant.identity
              ? 'user'
              : 'agent';
          const attributes = reader.info.attributes ?? {};
          const segmentId = attributes[ATTR_SEGMENT_ID] ?? reader.info.id;

          void (async () => {
            try {
              if (role === 'user') {
                const text = await reader.readAll();
                const final = attributes[ATTR_TRANSCRIPTION_FINAL] === 'true';
                for (const cb of listeners.transcript) {
                  cb({ role, segmentId, text, final });
                }
              } else {
                let text = '';
                for await (const chunk of reader) {
                  text += chunk;
                  for (const cb of listeners.transcript) {
                    cb({ role, segmentId, text, final: false });
                  }
                }
                for (const cb of listeners.transcript) {
                  cb({ role, segmentId, text, final: true });
                }
              }
            } catch {
              // A transcript stream dropping mid-read is cosmetic — skip it.
            }
          })();
        },
      );

      // Tool activity from the voice worker.
      // Client-tool invocations from the agent: run the app's handler and
      // stream the outcome back. Every path answers (unhandled/thrown/oversize
      // included) so the agent never waits out the timeout unnecessarily.
      room.registerTextStreamHandler(TOPIC_CLIENT_TOOL, (reader) => {
        void (async () => {
          let invocation: { id?: string; name?: string; args?: unknown };
          try {
            invocation = JSON.parse(await reader.readAll());
          } catch {
            return; // Malformed invocation — nothing to correlate a reply to.
          }
          if (!invocation.id || !invocation.name) {
            return;
          }
          const respond = async (response: Record<string, unknown>) => {
            try {
              await room.localParticipant.sendText(
                JSON.stringify({ id: invocation.id, ...response }),
                { topic: TOPIC_CLIENT_TOOL_RESULT },
              );
            } catch (err) {
              emitError(err as Error);
            }
          };

          const handler = clientToolHandlers.get(invocation.name);
          if (!handler) {
            console.warn(
              `[voice] client tool "${invocation.name}" invoked but no handler is registered — call session.registerClientTool()`,
            );
            await respond({ error: 'unhandled_client_tool' });
            return;
          }
          try {
            const result = await handler(invocation.args);
            const serialized =
              result === undefined ? undefined : JSON.stringify(result);
            if (
              serialized !== undefined &&
              serialized.length > CLIENT_TOOL_RESULT_MAX_CHARS
            ) {
              await respond({ error: 'result_too_large' });
              return;
            }
            await respond(result === undefined ? {} : { result });
          } catch (err) {
            await respond({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
      });

      room.registerTextStreamHandler(
        TOPIC_TOOL,
        (reader: TextStreamReader, participantInfo) => {
          if (!isAgent(participantInfo.identity)) {
            return;
          }
          void (async () => {
            try {
              const parsed = JSON.parse(await reader.readAll()) as {
                method?: string;
                status?: string;
                at?: number;
                result?: unknown;
                resultTruncated?: boolean;
              };
              if (!parsed.method) {
                return;
              }
              const status =
                parsed.status === 'done' || parsed.status === 'failed'
                  ? parsed.status
                  : 'running';
              for (const cb of listeners.toolCall) {
                cb({
                  method: parsed.method,
                  status,
                  at: parsed.at ?? Date.now(),
                  ...(parsed.result !== undefined
                    ? { result: parsed.result }
                    : {}),
                  ...(parsed.resultTruncated === true
                    ? { resultTruncated: true }
                    : {}),
                });
              }
            } catch {
              // Malformed tool event — skip it.
            }
          })();
        },
      );

      const abortHandler = () => {
        void room.disconnect();
      };
      options?.signal?.addEventListener('abort', abortHandler, { once: true });

      try {
        await room.connect(minted.url, minted.token);
        options?.signal?.throwIfAborted();

        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (err) {
          const name = (err as Error)?.name;
          if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
            throw new MindStudioInterfaceError(
              'Microphone access was denied. Allow microphone access for this site and try again.',
              'microphone_denied',
            );
          }
          if (name === 'NotFoundError') {
            throw new MindStudioInterfaceError(
              'No microphone was found on this device.',
              'microphone_not_found',
            );
          }
          throw err;
        }
      } catch (err) {
        await room.disconnect().catch(() => undefined);
        cleanup();
        if (options?.signal?.aborted) {
          throw new DOMException('Voice session aborted', 'AbortError');
        }
        throw err;
      } finally {
        options?.signal?.removeEventListener('abort', abortHandler);
      }

      const session: VoiceSession = {
        sessionId: minted.sessionId,
        room: minted.room,
        get state() {
          return state;
        },
        get isMuted() {
          return muted;
        },
        on(event, callback) {
          const set = listeners[event] as Set<typeof callback>;
          set.add(callback);
          return () => {
            set.delete(callback);
          };
        },
        async mute() {
          await room.localParticipant.setMicrophoneEnabled(false);
          muted = true;
        },
        async unmute() {
          await room.localParticipant.setMicrophoneEnabled(true);
          muted = false;
        },
        async sendText(text: string) {
          try {
            await room.localParticipant.sendText(text, { topic: TOPIC_CHAT });
          } catch (err) {
            emitError(err as Error);
            throw err;
          }
        },
        registerClientTool(
          name: string,
          handler: (args: unknown) => unknown | Promise<unknown>,
        ) {
          clientToolHandlers.set(name, handler);
          return () => {
            if (clientToolHandlers.get(name) === handler) {
              clientToolHandlers.delete(name);
            }
          };
        },
        async refreshIdentity() {
          await request(
            `/sessions/${encodeURIComponent(minted.sessionId)}/refresh-identity`,
            'POST',
            { previousToken: mintTimeToken },
          );
        },
        async end() {
          await room.disconnect();
          cleanup();
        },
      };

      // Publish the QA/debug handle (see VoiceQaHandle). Its buffers
      // subscribe through the same listener sets as app callbacks. Transcript
      // entries upsert by segment: events carry the full text so far, and the
      // agent side emits cumulative partials per chunk, so appending would
      // flood the buffer with near-duplicates of one utterance.
      const qaTranscript: VoiceTranscriptEvent[] = [];
      listeners.transcript.add((event) => {
        const idx = qaTranscript.findIndex(
          (e) => e.segmentId === event.segmentId && e.role === event.role,
        );
        if (idx >= 0) {
          qaTranscript[idx] = event;
        } else {
          qaTranscript.push(event);
          if (qaTranscript.length > QA_TRANSCRIPT_MAX_SEGMENTS) {
            qaTranscript.shift();
          }
        }
      });
      const qaToolCalls: VoiceToolCallEvent[] = [];
      listeners.toolCall.add((event) => {
        qaToolCalls.push(event);
        if (qaToolCalls.length > QA_TOOL_CALLS_MAX) {
          qaToolCalls.shift();
        }
      });
      qaHandle = {
        sessionId: minted.sessionId,
        get state() {
          return state;
        },
        transcript: qaTranscript,
        toolCalls: qaToolCalls,
        sendText: (text) => session.sendText(text),
        end: () => session.end(),
      };
      window.__MS_VOICE__ = qaHandle;

      return session;
    },

    async listSessions(cursor?: string): Promise<VoiceSessionListPage> {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request<VoiceSessionListPage>(`/sessions${query}`, 'GET');
    },

    async getSession(sessionId: string): Promise<VoiceSessionDetail> {
      return request<VoiceSessionDetail>(
        `/sessions/${encodeURIComponent(sessionId)}`,
        'GET',
      );
    },
  };
}
