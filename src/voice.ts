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
  /** End the session and release the microphone. */
  end(): Promise<void>;
}

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
      let state: VoiceSessionState = 'connecting';
      let muted = false;
      let audioEl: HTMLMediaElement | null = null;

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

      return {
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
        async end() {
          await room.disconnect();
          cleanup();
        },
      };
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
