# @mindstudio-ai/interface

Frontend SDK for MindStudio v2 app web interfaces. Provides typed RPC to backend methods, file uploads, and user context. Uses short-lived session tokens injected via `window.__MINDSTUDIO__`.

Completely separate from `@mindstudio-ai/agent` (which is privileged, backend-only, uses service-level tokens). This package uses short-lived session tokens and can only call the app's own methods.

## Project structure

```
src/
  index.ts          — exports: createClient, createAgentChatClient, platform, auth, MindStudioInterfaceError
  client.ts         — createClient() → Proxy-based method RPC client
  agent-chat.ts     — createAgentChatClient() → thread CRUD + SSE message streaming
  platform.ts       — uploadFile() via presigned S3 POST
  auth.ts           — user context from bootstrap globals (sync, read-only)
  config.ts         — reads window.__MINDSTUDIO__, validates, caches
  errors.ts         — MindStudioInterfaceError class
  types.ts          — BootstrapConfig, BootstrapUser
```

## Key commands

- `npm run build` — tsup build (ESM only, outputs dist/)
- `npm run dev` — tsup watch mode
- `npm run typecheck` — tsc --noEmit

## How it works

### Bootstrap

The MindStudio platform injects `window.__MINDSTUDIO__` into the page before the app's JS runs:

```js
window.__MINDSTUDIO__ = {
  token: "ms_iface_...",       // short-lived session token
  appId: "uuid",
  releaseId: "uuid",
  apiBaseUrl: "https://api.mindstudio.ai",
  user: { id, name, email, profilePictureUrl },
  methods: {                   // export name → method ID
    "submitVendorRequest": "submit-vendor-request",
    "getDashboard": "get-dashboard",
  }
};
```

The SDK reads this on first use (lazy — doesn't throw during import).

### Method RPC (`createClient`)

```ts
import { createClient } from '@mindstudio-ai/interface';

const api = createClient();
const result = await api.submitVendorRequest({ name: 'Acme' });
const dashboard = await api.getDashboard();
```

Each method call:
1. Looks up method ID from `config.methods[methodName]`
2. POSTs to `{apiBaseUrl}/_internal/v2/apps/{appId}/methods/{methodId}/invoke`
3. Body: `{ input: { ...args } }`, Header: `Authorization: Bearer {token}`
4. Returns `response.output` or throws `MindStudioInterfaceError`

Type safety via generic parameter:
```ts
interface AppMethods {
  submitVendorRequest(input: SubmitVendorInput): Promise<SubmitVendorOutput>;
  getDashboard(): Promise<GetDashboardOutput>;
}
const api = createClient<AppMethods>();
```

### File uploads (`platform`)

```ts
import { platform } from '@mindstudio-ai/interface';

const url = await platform.uploadFile(file);
```

`uploadFile` uses a two-step presigned POST flow:
1. Requests a presigned upload URL from `/_internal/v2/apps/{appId}/generate-upload-request`
2. Uploads the file directly to S3 via the presigned URL
3. Returns the public CDN URL

### User context (`auth`)

```ts
import { auth } from '@mindstudio-ai/interface';

auth.userId             // "uuid"
auth.name               // "Sean"
auth.email              // "sean@example.com"
auth.profilePictureUrl  // "https://..." or null
```

Display purposes only — role checking is a backend concern.

### Agent chat (`createAgentChatClient`)

```ts
import { createAgentChatClient } from '@mindstudio-ai/interface';

const chat = createAgentChatClient();

// Thread lifecycle
const thread = await chat.createThread();
const { threads } = await chat.listThreads();
const full = await chat.getThread(thread.id);
await chat.updateThread(thread.id, 'New title');
await chat.deleteThread(thread.id);

// Send message with streaming
const response = chat.sendMessage(thread.id, 'Hello!', {
  onText: (delta) => setMessage((prev) => prev + delta),
  onToolCallStart: (id, name) => showSpinner(name),
  onToolCallResult: (id, output) => showResult(output),
});
const { stopReason, usage } = await response;
response.abort(); // cancel mid-stream
```

Stateless client — thread CRUD and message streaming over SSE. The app manages its own state.

**Thread endpoints:** `/_internal/v2/apps/{appId}/agent/threads/...`

**SSE events:** `text`, `thinking`, `thinking_complete`, `tool_use`, `tool_input_delta`, `tool_call_start`, `tool_call_result`, `done`, `error`. Named callbacks for common events + `onEvent` catch-all for the full discriminated union.

**Abort:** `sendMessage` returns an `AbortablePromise` — a Promise with `.abort()`. Also accepts `signal` in callbacks for `AbortController` integration.

## Architecture notes

- **Zero runtime dependencies.** Uses built-in `fetch` only.
- **ESM only.** `"type": "module"` in package.json.
- **Browser-only.** No Node.js APIs.
- **Lazy initialization.** `getConfig()` reads `window.__MINDSTUDIO__` on first property access, not on import. Safe for SSR/test environments as long as you don't call methods.
- **Proxy-based client.** `createClient()` returns a Proxy — any property access creates an async invoker function. No code generation needed.
- **Session tokens.** Short-lived (`ms_iface_...`), scoped to app + user. Can only invoke that app's methods. Cannot access db/auth directly — those are backend concerns.

## Comparison with @mindstudio-ai/agent

| Aspect | `@mindstudio-ai/agent` | `@mindstudio-ai/interface` |
|--------|----------------------|--------------------------|
| Runs in | Backend (sandbox, CLI, CI) | Frontend (browser) |
| Token type | API key / hook token (privileged) | Short-lived session token |
| Can access | All steps, db, auth roles, AI models | Only app's own methods |
| Data operations | `db.defineTable()`, SQL via SDK | Calls backend methods that use db |
| Auth | Full role map, `requireRole()` | User fragment for display only |
| File operations | `mindstudio.uploadFile()` server-side | `platform.uploadFile()` via presigned S3 POST |

## Code style

- Prettier: single quotes, trailing commas, 80 char width, 2-space indent
- Strict TypeScript
