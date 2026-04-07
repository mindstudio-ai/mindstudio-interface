# @mindstudio-ai/interface

Frontend SDK for [MindStudio](https://mindstudio.ai) v2 app web interfaces.

Typed RPC to backend methods, file uploads, authentication, and agent chat — all from the browser. Zero dependencies.

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
await auth.logout()      // clears session
```

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
| `not_authenticated` | 401 | No auth session (change/logout endpoints) |
| `invalid_session` | 401 | Session expired or invalid |

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

// Paginate
const page2 = await chat.listThreads(nextCursor);
```

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

#### SSE event types

All events are available via the `onEvent` catch-all as the `AgentChatEvent` discriminated union:

| Event | Fields | Named callback |
|-------|--------|----------------|
| `text` | `text` (delta) | `onText` |
| `thinking` | `text` (delta) | `onThinking` |
| `thinking_complete` | `thinking`, `signature` | `onThinkingComplete` |
| `tool_call_start` | `id`, `name` | `onToolCallStart` |
| `tool_call_result` | `id`, `output` | `onToolCallResult` |
| `error` | `error` | `onError` |
| `tool_use` | `id`, `name`, `input` | `onEvent` only |
| `tool_input_delta` | `id`, `name`, `delta` | `onEvent` only |
| `done` | `stopReason`, `usage` | resolves the Promise |

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

## License

MIT
