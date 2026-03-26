# @mindstudio-ai/interface

Frontend SDK for [MindStudio](https://mindstudio.ai) v2 app web interfaces.

Typed RPC to backend methods, file uploads, and user context — all from the browser. Zero dependencies, <3KB minified.

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

The MindStudio platform injects `window.__MINDSTUDIO__` into the page before your code runs. This contains the session token, app/release IDs, user info, and method registry. The SDK reads this automatically — no configuration needed.

Method calls and file uploads go directly to the API via `fetch`.

## License

MIT
