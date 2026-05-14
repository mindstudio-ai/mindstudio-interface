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
  telemetry-errors.ts       — auto error capture + batched transport to /_/telemetry/errors
  telemetry-breadcrumbs.ts  — ring buffer + fetch/XHR/history patches; exposes onNavigation()
  telemetry-analytics.ts    — auto pageviews + analytics.track() to /_/telemetry/events
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

Verify/confirm/logout methods update `window.__MINDSTUDIO__` in-place with the returned `{ user, token, methods, visitorId }` bundle. All downstream calls (method invocation, agent chat, uploads) immediately use the new session.

**User shape (`AppUser`):** `{ id, email, phone, roles, apiKey, createdAt }` — same everywhere (bootstrap, API responses, `getCurrentUser()`). `null` means unauthenticated.

**Visitor ID:** `auth.currentVisitorId` returns a stable per-browser, per-app opaque string. Backed by a server-set HttpOnly cookie scoped to the exact subdomain; persists ~1 year (rolling). For authed sessions it's the user's platform user ID; for guests it's a per-browser UUID. Updates automatically on login/logout transitions alongside `currentUser`. Useful for app-side analytics, "welcome back" UX for guests, per-visitor preferences keyed in the app DB.

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

### Error reporting (telemetry)

Auto-captures uncaught errors + unhandled promise rejections and ships them to `/_/telemetry/errors` for backend bucketing/dashboards. **No public API** — install is a side effect of the first `getConfig()` call (i.e. the first SDK access).

```ts
// Auto-installed on first SDK use. Nothing to import or call.

// Opt out per app via bootstrap config:
window.__MINDSTUDIO__.telemetry = { errors: false };
```

**What's captured per event:** `type`, `message`, `stack`, `source`/`line`/`column`, plus SDK context (`releaseId`, `url`, `userAgent`, `timestamp`) and a snapshot of breadcrumbs (last ~20 navigations + fetch/XHR calls). User identity is derived server-side from the session token; client-supplied `userId` / `visitorId` are ignored.

**Breadcrumbs** are collected via three monkeypatches: `history.pushState`/`replaceState`/`popstate` for navigation, `window.fetch` and `XMLHttpRequest` for network calls. All idempotent (HMR-safe). Calls to `/_/telemetry/*` are excluded to prevent reporting loops.

**Transport:** batched ~1s debounce, max 50 events per POST. Within-batch dedupe via `count: N` on events with identical `message + first-stack-line`. Drains via `fetch` with `keepalive: true` on `pagehide` / `visibilitychange === 'hidden'`. Respects `429` + `Retry-After`. Any transport failure is silently swallowed — telemetry never crashes the host app.

**Response body capture:** `window.__MINDSTUDIO__.telemetryCaptureResponseBodies = true` attaches truncated (~1KB) response bodies to failed-fetch breadcrumbs. Off by default. Backend strips the field unless the per-app setting is also enabled.

**First-paint errors:** the SDK installs on first `getConfig()` call, so errors thrown before any SDK access aren't captured. Apps wanting earliest capture can touch any SDK accessor (e.g. `auth.currentUser`) at app entry.

**Endpoint:** `POST /_/telemetry/errors` — same Bearer session token as everywhere else.

### Analytics (`analytics`)

Plausible/Fathom-style visitor analytics. Auto-tracks pageviews on every history change. Public API is a single method:

```ts
import { analytics } from '@mindstudio-ai/interface';

// Custom events (optional — pageviews track automatically)
analytics.track('vendor_submitted', { vendorType: 'restaurant' });

// Opt out per app via bootstrap config:
window.__MINDSTUDIO__.telemetry = { analytics: false };
```

**Auto-pageviews:** subscribes to navigation events from `telemetry-breadcrumbs.ts` (one set of history patches shared across error breadcrumbs + analytics). Hooks `pushState`, `replaceState`, `popstate`, `hashchange`. Fires an initial pageview on install. Naturally de-dupes identical-URL consecutive navigations.

**What's sent per pageview:** `type: 'pageview'`, `releaseId`, `url` (full `location.href`), `referrer`, `userAgent`, `language`, `screen: { w, h }`, `timestamp`. Server enriches with geo (IP → country), device class + browser + OS (UA parsing), UTMs (query string), and visitor identity (from session). SDK does none of that parsing.

**Custom events:** `analytics.track(name, props?)`. Props must be flat primitives (`string | number | boolean`); non-primitive values are stripped client-side before send. Server caps further (name ≤200 chars, 10 keys × 50-char keys × 500-char values).

**Transport:** batched ~1s debounce, max 100 events per POST. Drains via `fetch` with `keepalive: true` on `pagehide` / `visibilitychange === 'hidden'`. Respects `429 + Retry-After`. Silently swallows all failures.

**URL scrubbing:** server enforces a query-string whitelist (UTMs + a few common params). SDK sends raw `location.href`; backend strips before storage. Belt-and-suspenders.

**Presence (silent):** the SDK opens a long-lived SSE connection to `/_/telemetry/presence` on install and holds it open as a heartbeat — the connection itself is the "visitor is online" signal. Any count data the server pushes over it is read-and-discarded; the SDK never surfaces presence info to app code. Tab close / network drop closes the connection; server immediately knows the visitor is gone. Auto-reconnects with exponential backoff (1s/2s/5s/10s + jitter); handles `503` via `Retry-After`; stops on `401`.

**Privacy posture — no visitor-facing presence API:** aggregate visitor metrics (including live count) are surfaced only through the platform dashboard to the app owner. The SDK intentionally exposes no live-count or presence/aggregate-visitor API to app code — visitors must not be able to learn about other visitors' presence through the SDK. Apps that want presence as a designed feature (e.g. multiplayer experiences) must build it at the application level with their own consent semantics.

**Endpoints:** `POST /_/telemetry/events` (batched ingest), `GET /_/telemetry/presence` (silent heartbeat connection — SDK opens, discards data).

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
