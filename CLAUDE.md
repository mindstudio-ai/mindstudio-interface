# @mindstudio-ai/interface

Frontend SDK for MindStudio v2 app web interfaces. Runs inside iframes on `*.static.mscdn.ai`, provides typed RPC to backend routes and platform actions (file picker, uploads).

Completely separate from `@mindstudio-ai/agent` (which is privileged, backend-only, uses service-level tokens). This package uses short-lived session tokens and can only call the app's own routes.

## Project structure

```
src/
  index.ts          — exports: createClient, platform, auth, MindStudioInterfaceError
  client.ts         — createClient() → Proxy-based route RPC client
  platform.ts       — requestFile() via postMessage + uploadFile() via fetch
  auth.ts           — user context from bootstrap globals (sync, read-only)
  config.ts         — reads window.__MINDSTUDIO__, validates, caches
  errors.ts         — MindStudioInterfaceError class
  types.ts          — BootstrapConfig, BootstrapUser, RequestFileOptions
```

## Key commands

- `npm run build` — tsup build (ESM only, outputs dist/)
- `npm run dev` — tsup watch mode
- `npm run typecheck` — tsc --noEmit

## How it works

### Bootstrap

The MindStudio platform injects `window.__MINDSTUDIO__` into the iframe's `index.html` before the app's JS runs:

```js
window.__MINDSTUDIO__ = {
  token: "ms_iface_...",       // short-lived session token
  appId: "uuid",
  releaseId: "uuid",
  apiBaseUrl: "https://api.mindstudio.ai",
  user: { id, name, email, profilePictureUrl },
  routes: {                    // export name → route ID
    "submitVendorRequest": "submit-vendor-request",
    "getDashboard": "get-dashboard",
  }
};
```

The SDK reads this on first use (lazy — doesn't throw during import).

### Route RPC (`createClient`)

```ts
import { createClient } from '@mindstudio-ai/interface';

const api = createClient();
const result = await api.submitVendorRequest({ name: 'Acme' });
const dashboard = await api.getDashboard();
```

Each method call:
1. Looks up route ID from `config.routes[methodName]`
2. POSTs to `{apiBaseUrl}/_internal/v2/apps/{appId}/routes/{routeId}/invoke`
3. Body: `{ input: { ...args } }`, Header: `Authorization: Bearer {token}`
4. Returns `response.output` or throws `MindStudioInterfaceError`

Type safety via generic parameter:
```ts
interface AppRoutes {
  submitVendorRequest(input: SubmitVendorInput): Promise<SubmitVendorOutput>;
  getDashboard(): Promise<GetDashboardOutput>;
}
const api = createClient<AppRoutes>();
```

### Platform actions (`platform`)

```ts
import { platform } from '@mindstudio-ai/interface';

// Open the asset library / file picker (postMessage to host)
const url = await platform.requestFile({ type: 'image' });

// Direct upload without picker (HTTP POST)
const uploaded = await platform.uploadFile(file);
```

`requestFile` uses the postMessage callback token pattern:
1. Generate `callbackToken = crypto.randomUUID()`
2. Send to parent: `{ action: 'requestFile', type?, callbackToken }`
3. Parent opens modal, user picks file
4. Parent sends back: `{ action: 'callback', callbackToken, result: { url } }`
5. Promise resolves with URL

`uploadFile` is direct HTTP to `/_internal/v2/apps/{appId}/upload`.

### User context (`auth`)

```ts
import { auth } from '@mindstudio-ai/interface';

auth.userId             // "uuid"
auth.name               // "Sean"
auth.email              // "sean@example.com"
auth.profilePictureUrl  // "https://..." or null
```

Display purposes only — role checking is a backend concern.

## Architecture notes

- **Zero runtime dependencies.** Uses built-in `fetch` and `postMessage`.
- **ESM only.** `"type": "module"` in package.json.
- **Browser-only.** No Node.js APIs.
- **Lazy initialization.** `getConfig()` reads `window.__MINDSTUDIO__` on first property access, not on import. Safe for SSR/test environments as long as you don't call methods.
- **Proxy-based client.** `createClient()` returns a Proxy — any property access creates an async invoker function. No code generation needed.
- **Session tokens.** Short-lived (`ms_iface_...`), scoped to app + user. Can only invoke that app's routes. Cannot access db/auth directly — those are backend concerns.

## Comparison with @mindstudio-ai/agent

| Aspect | `@mindstudio-ai/agent` | `@mindstudio-ai/interface` |
|--------|----------------------|--------------------------|
| Runs in | Backend (sandbox, CLI, CI) | Frontend (browser, iframe) |
| Token type | API key / hook token (privileged) | Short-lived session token |
| Can access | All steps, db, auth roles, AI models | Only app's own routes |
| Data operations | `db.defineTable()`, SQL via SDK | Calls backend routes that use db |
| Auth | Full role map, `requireRole()` | User fragment for display only |
| File operations | `mindstudio.uploadFile()` server-side | `platform.requestFile()` via picker |

## Code style

- Prettier: single quotes, trailing commas, 80 char width, 2-space indent
- Strict TypeScript
