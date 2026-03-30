# @mindstudio-ai/interface

Frontend SDK for [MindStudio](https://mindstudio.ai) v2 app web interfaces.

Typed RPC to backend methods, file uploads, agent chat, and user context — all from the browser. Zero dependencies.

## Install

```bash
npm install @mindstudio-ai/interface
```

## Usage

```tsx
import { createClient, platform, auth } from '@mindstudio-ai/interface';

const api = createClient();

function App() {
  const [dashboard, setDashboard] = useState(null);

  useEffect(() => {
    api.getDashboard().then(setDashboard);
  }, []);

  const handleUpload = async (file: File) => {
    const url = await platform.uploadFile(file);
    // use the CDN url...
  };

  return (
    <div>
      <p>Welcome, {auth.name}</p>
      <img src={auth.profilePictureUrl} />
      <input type="file" onChange={(e) => handleUpload(e.target.files[0])} />
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

Current user's identity (read-only, synchronous):

```ts
auth.userId             // "uuid"
auth.name               // "Sean"
auth.email              // "sean@example.com"
auth.profilePictureUrl  // "https://..." or null
```

For display purposes only. Role checking and permissions are handled by backend routes using `@mindstudio-ai/agent`.

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

The MindStudio platform injects `window.__MINDSTUDIO__` into the page before your code runs. This contains the session token, user info, and method registry. The SDK reads this automatically — no configuration needed.

All API calls use same-origin `/_/` paths (e.g. `/_/methods/{id}/invoke`, `/_/agent/threads`). The platform proxy resolves the app from the subdomain — no cross-origin requests or app IDs in URLs. This works identically in production and local dev.

## License

MIT
