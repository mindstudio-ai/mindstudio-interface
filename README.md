# @mindstudio-ai/interface

Frontend SDK for [MindStudio](https://mindstudio.ai) v2 app web interfaces.

Typed RPC to backend methods, file uploads, authentication, agent chat, and realtime voice — all from the browser. The core entry has zero dependencies; voice lives on the `./voice` subpath and loads its media transport (`livekit-client`) only when a session starts.

## Install

```bash
npm install @mindstudio-ai/interface
```

## Usage

```tsx
import { createClient, platform, auth, type AppUser } from '@mindstudio-ai/interface';

const api = createClient();

// Reactive auth state — re-renders on login/logout
function useAuth() {
  const [user, setUser] = useState<AppUser | null>(null);
  useEffect(() => auth.onAuthStateChanged(setUser), []);
  return user;
}

function App() {
  const user = useAuth();

  if (!user) return <LoginPage />;

  return <Dashboard user={user} />;
}

function Dashboard({ user }: { user: AppUser }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.getDashboard().then(setData);
  }, []);

  return (
    <div>
      <p>Welcome, {user.email}</p>
      <button onClick={() => auth.logout()}>Log out</button>
    </div>
  );
}
```

## API

### `createClient<T>()`

Returns a typed RPC client. Each method maps to a backend route:

```ts
const api = createClient();

const result = await api.submitVendorRequest({ name: 'Acme' });
const dashboard = await api.getDashboard();
```

For type safety, pass an interface matching your backend routes:

```ts
import type { SubmitVendorInput } from '../../backend/src/submitVendorRequest';

interface AppRoutes {
  submitVendorRequest(input: SubmitVendorInput): Promise<{ vendorId: string }>;
  getDashboard(): Promise<DashboardData>;
}

const api = createClient<AppRoutes>();
```

### `platform.uploadFile(file)`

Upload a file to the MindStudio CDN. Returns a public CDN URL.

```ts
const url = await platform.uploadFile(file);
```

### `auth`

Authentication flows, user state, and validation helpers. The platform handles verification code delivery, cookie management, and user storage — you build the login UI.

#### Login flow

```tsx
import { auth } from '@mindstudio-ai/interface';

// Send a verification code
const { verificationId } = await auth.sendEmailCode('user@example.com');

// User enters the code in your UI...
const user = await auth.verifyEmailCode(verificationId, code);
// Session is now active — all SDK calls use the authenticated token
```

SMS works the same way — use `auth.sendSmsCode(phone)` and `auth.verifySmsCode(verificationId, code)`. Phone numbers must be E.164 format.

#### User state

```ts
auth.getCurrentUser()    // { id, email, phone, roles, createdAt } or null
auth.isAuthenticated()   // boolean
auth.currentVisitorId    // stable per-browser, per-app opaque ID (or null)
await auth.logout()      // clears session
```

`currentVisitorId` is a stable identifier for this browser on this app, backed by a server-set HttpOnly cookie. It's the user's platform user ID when authenticated, a per-browser UUID when not. Persists ~1 year and updates in-place on login/logout. Useful for app-side analytics, "welcome back" UX for guests, or per-visitor preferences stored in your app's data DB.

#### Phone helpers

Utilities for building a phone input with country code picker:

```ts
auth.phone.countries          // [{ code: 'US', dialCode: '+1', name: 'United States', flag: '🇺🇸' }, ...]
auth.phone.detectCountry()    // 'US' — guessed from timezone
auth.phone.toE164('5551234567', 'US')  // '+15551234567'
auth.phone.format('+15551234567')      // '+1 (555) 123-4567'
auth.phone.isValid('+15551234567')     // true
auth.email.isValid('user@example.com') // true
```

#### Email/phone change

Authenticated users can change their email or phone through a verification flow:

```ts
await auth.requestEmailChange('new@example.com');
await auth.confirmEmailChange('new@example.com', code);
```

#### API keys

Apps with `api-key` in their auth methods can let users generate keys for programmatic access:

```ts
const { key } = await auth.createApiKey();   // full key (sk_...), shown once
console.log(auth.currentUser?.apiKey);       // masked: "sk_...a1b2"

await auth.revokeApiKey();                   // apiKey becomes null
```

Both methods trigger `onAuthStateChanged` since the user's `apiKey` field changes.

#### Reactive auth state

`onAuthStateChanged` fires immediately with the current user, then again on every auth transition. Use it to build reactive UIs:

```ts
// React hook
function useAuth() {
  const [user, setUser] = useState<AppUser | null>(null);
  useEffect(() => auth.onAuthStateChanged(setUser), []);
  return user;
}
```

You can also read the current user synchronously via `auth.currentUser`.

#### Auth error codes

Auth methods throw `MindStudioInterfaceError`. Handle specific cases via `err.code`:

| Code | Status | Meaning |
|------|--------|---------|
| `rate_limited` | 429 | Too many code requests (max 5 per 15 min) |
| `invalid_code` | 400 | Wrong verification code |
| `verification_expired` | 400 | Code expired (10 min TTL) |
| `max_attempts_exceeded` | 400 | Too many incorrect attempts (max 3) |
| `not_authenticated` | 401 | No auth session (change/logout/api-key endpoints) |
| `invalid_session` | 401 | Session expired or invalid |
| `not_supported` | 400 | Feature not enabled (e.g. api-key auth not in app methods) |

```ts
try {
  await auth.verifyEmailCode(verificationId, code);
} catch (err) {
  if (err instanceof MindStudioInterfaceError) {
    if (err.code === 'invalid_code') {
      showError('Wrong code, try again');
    } else if (err.code === 'verification_expired') {
      showError('Code expired — sending a new one');
      await auth.sendEmailCode(email);
    }
  }
}
```

#### Session management

Verify, confirm, and logout methods update the SDK's internal session in-place. All downstream calls (method invocation, agent chat, uploads) immediately use the new authenticated (or unauthenticated) session. No page refresh needed.

### `createAgentChatClient()`

Stateless client for thread-based conversations with AI agents. The agent runs server-side with access to your app's methods as tools.

#### Thread management

```ts
import { createAgentChatClient } from '@mindstudio-ai/interface';

const chat = createAgentChatClient();

const thread = await chat.createThread();
const { threads, nextCursor } = await chat.listThreads();
const full = await chat.getThread(thread.id);
await chat.updateThread(thread.id, 'New title');
await chat.deleteThread(thread.id);
await chat.claimThread(thread.id); // after in-app login: keep anonymous threads

// Paginate
const page2 = await chat.listThreads(nextCursor);
```

If the app's agent interface declares an `auth` block, `createThread` and `sendMessage` reject
with `MindStudioInterfaceError` code `auth_required` (401, no authenticated user) or
`role_required` (403, user lacks a required role) — route those to the app's login flow.
`createThread` also throws `no_agent_config` (404) when the app has no live agent interface.

#### Sending messages

`sendMessage` streams the agent's response via SSE. Named callbacks handle common events; the catch-all `onEvent` receives everything as a discriminated union.

```tsx
function ChatInput({ threadId }: { threadId: string }) {
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState('');
  const [tools, setTools] = useState<Map<string, string>>(new Map());

  const send = (content: string) => {
    const response = chat.sendMessage(threadId, content, {
      // Text deltas — append, don't replace
      onText: (delta) => setText((prev) => prev + delta),

      // Extended thinking (also deltas)
      onThinking: (delta) => setThinking((prev) => prev + delta),
      onThinkingComplete: (thinking, signature) => setThinking(''),

      // Tool execution
      onToolCallStart: (id, name) =>
        setTools((m) => new Map(m).set(id, `Running ${name}...`)),
      onToolCallResult: (id, output) =>
        setTools((m) => new Map(m).set(id, JSON.stringify(output))),

      // Errors
      onError: (error) => console.error('Stream error:', error),

      // Catch-all for logging or low-level events (tool_use, tool_input_delta)
      onEvent: (event) => console.log(event.type, event),
    });

    // Resolves when stream completes
    response.then(({ stopReason, usage }) => {
      console.log(`Done: ${stopReason}, tokens: ${usage.inputTokens}+${usage.outputTokens}`);
    });

    // Cancel mid-stream
    // response.abort();
  };
}
```

#### Abort support

`sendMessage` returns an `AbortablePromise` — a standard Promise with an `.abort()` method. You can also pass an `AbortSignal` via the callbacks:

```ts
const controller = new AbortController();

const response = chat.sendMessage(threadId, content, {
  onText: (delta) => setText((prev) => prev + delta),
  signal: controller.signal,
});

// Either works:
response.abort();
controller.abort();
```

#### Attachments

Send images or documents alongside a message. Upload files first via `platform.uploadFile()`, then pass the CDN URLs:

```ts
const url = await platform.uploadFile(file);

chat.sendMessage(threadId, "What's in this document?", {
  onText: (delta) => setText((prev) => prev + delta),
}, {
  attachments: [url],
});
```

- **Images** (`i.mscdn.ai`): Sent to the model as vision input (one image per message)
- **Documents** (`f.mscdn.ai`): Text extracted server-side and included in context

Attachments are preserved in thread history — when you load a thread via `getThread()`, user messages include their original `attachments` array.

#### Client tools

A tool declared in `agent.md` with `target: "client"` runs in this browser instead of the app's backend. Register a handler and its return value goes back to the agent as the tool result, so the agent knows what happened instead of assuming:

```ts
const unregister = chat.registerClientTool('pickFile', async ({ prompt }) => {
  const file = await openFilePicker(prompt);
  return file ? { path: file.path } : { cancelled: true };
});
```

The agent holds its turn while your handler runs, for up to 15 minutes — long enough that a handler can resolve from a dialog's Save button rather than returning immediately, which is what makes confirm-before-acting possible:

```ts
chat.registerClientTool('confirmDeploy', ({ summary }) =>
  new Promise((resolve) => {
    showApprovalDialog(summary, {
      onApprove: (note) => resolve({ approved: true, note }),
      onReject: (reason) => resolve({ approved: false, reason }),
    });
  }),
);
```

The SDK always answers, so the agent is never left hanging: your return value, `{ error: <message> }` if the handler throws, `result_too_large` past ~32KB serialized, and `unhandled_client_tool` immediately when no handler is registered for the name. If nothing answers within the window the agent gets `client_timeout`; closing the page gets it `client_disconnected`.

Handlers are keyed by tool name, live for the lifetime of the client rather than one message, and the returned function unregisters. For a one-off, the `onClientToolCall` callback on `sendMessage` works the same way — whatever it returns becomes the result — and is consulted only when no handler is registered for that name.

#### SSE event types

All events are available via the `onEvent` catch-all as the `AgentChatEvent` discriminated union:

| Event | Fields | Named callback |
|-------|--------|----------------|
| `text` | `text` (delta) | `onText` |
| `thinking` | `text` (delta) | `onThinking` |
| `thinking_complete` | `thinking`, `signature` | `onThinkingComplete` |
| `tool_call_start` | `id`, `name` | `onToolCallStart` |
| `tool_call_result` | `id`, `output` | `onToolCallResult` |
| `client_tool_call` | `id`, `name`, `input`, `timeoutMs` | answered by `registerClientTool` |
| `error` | `error` | `onError` |
| `tool_use` | `id`, `name`, `input` | `onEvent` only |
| `tool_input_delta` | `id`, `name`, `delta` | `onEvent` only |
| `done` | `stopReason`, `usage` | resolves the Promise |

### createVoiceClient()

Realtime voice sessions for apps with a voice interface. Imported from the `./voice` subpath — the
media transport (`livekit-client`) loads dynamically on the first `startSession()`, so apps that
never use voice ship none of it.

```ts
import { createVoiceClient } from '@mindstudio-ai/interface/voice';

const voice = createVoiceClient();
const session = await voice.startSession();

session.on('stateChange', (state) => setOrbState(state));
// 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended'

session.on('transcript', ({ role, segmentId, text, final }) =>
  upsertCaption(segmentId, role, text, final),
); // full text per segment (never deltas); same segmentId replaces

session.on('toolCall', ({ method, status, result }) => {
  showToolStatus(method, status);
  // Every successful tool delivers its raw return value here on 'done' —
  // render what the agent just did in lockstep with speech. Over ~32KB
  // serialized arrives as `resultTruncated: true` instead.
  if (status === 'done' && result !== undefined) renderToolResult(method, result);
});

session.mute();
session.unmute();
await session.sendText('123 Main Street'); // exact strings beat spelling aloud
// Client tools (voice.md `target: "client"`): the agent invokes, your handler
// runs in this browser, and its return value goes back as the tool result.
session.registerClientTool('showVerification', async (args) => {
  openVerifySheet(args);
  return { opened: true };
});

// Progressive auth: after your in-app verification succeeds, upgrade the live
// session anonymous → signed-in in place (no teardown, conversation continues).
await session.refreshIdentity();
await session.end();
```

Agent audio playback is handled by the SDK (a hidden autoplaying element) — the app never touches
audio elements. `startSession()` throws `MindStudioInterfaceError` with code `microphone_denied`
when mic access is refused, `voice_concurrency_limit` / `voice_visitor_limit` when the app's
session limits are hit, or `auth_required` (401) / `role_required` (403) when the voice
interface's `auth` block denies the caller — route those to the app's login flow.

Past sessions are call records:

```ts
const { sessions, nextCursor } = await voice.listSessions();
const detail = await voice.getSession(sessions[0].id); // includes transcript
```

## Error handling

```ts
import { MindStudioInterfaceError } from '@mindstudio-ai/interface';

try {
  await api.submitVendorRequest({ name: '' });
} catch (err) {
  if (err instanceof MindStudioInterfaceError) {
    console.error(err.message); // human-readable
    console.error(err.code);    // 'route_error', 'forbidden', etc.
    console.error(err.status);  // HTTP status
  }
}
```

## How it works

The MindStudio platform injects `window.__MINDSTUDIO__` into the page before your code runs. This contains the session token, authenticated user (or `null`), and method registry. The SDK reads this automatically — no configuration needed.

All API calls use same-origin `/_/` paths (e.g. `/_/methods/{id}/invoke`, `/_/agent/threads`, `/_/auth/email/send`). The platform proxy resolves the app from the subdomain — no cross-origin requests or app IDs in URLs. This works identically in production and local dev.

Authentication is cookie-based (`HttpOnly`, `Secure`, `SameSite=Lax`). The SDK never touches the cookie directly — it's set by the server on verify and cleared on logout. Auth state transitions (login, logout, email/phone change) return a fresh session token which the SDK applies in-place, so all subsequent API calls use the new session without a page refresh.

## Error reporting

Uncaught errors and unhandled promise rejections are automatically captured and shipped to the platform for bucketing + dashboards. No setup required — install happens automatically on page load (next tick after the SDK module loads). Reports include the error, a stack, and a breadcrumb trail of recent navigations + network calls for context.

Opt out per app via bootstrap config:

```ts
window.__MINDSTUDIO__.telemetry = { errors: false };
```

Failed-fetch breadcrumbs can optionally include response bodies (off by default; enable both client-side via `window.__MINDSTUDIO__.telemetryCaptureResponseBodies = true` and via the per-app setting in the dashboard).

## Analytics

Visitor analytics — pageviews, referrers, UTMs, geo, devices — Plausible/Fathom style. Pageviews are tracked automatically on every history change (`pushState`, `replaceState`, `popstate`, `hashchange`). Server-side enrichment handles geo, UA parsing, UTM extraction, and sessionization. Aggregate visitor metrics are surfaced through the platform dashboard to the app owner.

```ts
import { analytics } from '@mindstudio-ai/interface';

// Custom events (optional — pageviews track automatically)
analytics.track('vendor_submitted', { vendorType: 'restaurant' });
```

Custom event props must be flat primitives (`string | number | boolean`) — non-primitive values are stripped client-side before send.

Opt out per app via bootstrap config:

```ts
window.__MINDSTUDIO__.telemetry = { analytics: false };
```

## License

MIT
