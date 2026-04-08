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
  auth.ts           — auth flows (email/SMS codes, session state, logout)
  auth-phone.ts     — phone helpers (countries, formatting, E.164 conversion)
  auth-email.ts     — email validation
  config.ts         — reads window.__MINDSTUDIO__, validates, caches, updateConfig()
  errors.ts         — MindStudioInterfaceError class
  types.ts          — BootstrapConfig, AppUser, AuthSessionBundle
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
  releaseId: "uuid",
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
2. POSTs to `/_/methods/{methodId}/invoke`
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
1. Requests a presigned upload URL from `/_/generate-upload-request`
2. Uploads the file directly to S3 via the presigned URL
3. Returns the public CDN URL

### Authentication (`auth`)

```ts
import { auth } from '@mindstudio-ai/interface';

// State (sync — reads from cached bootstrap config)
auth.getCurrentUser()    // AppUser | null
auth.isAuthenticated()   // boolean

// Email code flow
const { verificationId } = await auth.sendEmailCode('user@example.com');
const user = await auth.verifyEmailCode(verificationId, '123456');

// SMS code flow
const { verificationId } = await auth.sendSmsCode('+15551234567');
const user = await auth.verifySmsCode(verificationId, '123456');

// Email/phone change (requires authentication)
await auth.requestEmailChange('new@example.com');
await auth.confirmEmailChange('new@example.com', '123456');

// Logout
await auth.logout();

// API keys (requires authentication, app must have api-key auth enabled)
const { key } = await auth.createApiKey();  // full key, shown once
await auth.revokeApiKey();                  // user.apiKey becomes null

// Phone helpers
auth.phone.countries          // [{ code: 'US', dialCode: '+1', name: 'United States', flag: '🇺🇸' }, ...]
auth.phone.detectCountry()    // 'US' (from timezone)
auth.phone.toE164('5551234567', 'US')  // '+15551234567'
auth.phone.format('+15551234567')      // '+1 (555) 123-4567'
auth.phone.isValid('+15551234567')     // true

// Email helpers
auth.email.isValid('user@example.com') // true
```

Verify/confirm/logout methods update `window.__MINDSTUDIO__` in-place with the returned `{ user, token, methods }` bundle. All downstream calls (method invocation, agent chat, uploads) immediately use the new session.

**User shape (`AppUser`):** `{ id, email, phone, roles, apiKey, createdAt }` — same everywhere (bootstrap, API responses, `getCurrentUser()`). `null` means unauthenticated.

**Endpoints:** `/_/auth/email/send`, `/_/auth/email/verify`, `/_/auth/sms/send`, `/_/auth/sms/verify`, `/_/auth/email/change`, `/_/auth/email/change/confirm`, `/_/auth/phone/change`, `/_/auth/phone/change/confirm`, `/_/auth/logout`, `/_/auth/me`, `/_/auth/api-key/create`, `/_/auth/api-key/revoke`.

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

// Send with attachments (upload first via platform.uploadFile())
chat.sendMessage(thread.id, 'What is this?', callbacks, {
  attachments: ['https://i.mscdn.ai/.../photo.png'],
});
```

Stateless client — thread CRUD and message streaming over SSE. The app manages its own state.

**Thread endpoints:** `/_/agent/threads/...`

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
