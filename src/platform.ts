/**
 * Platform actions — file picker and uploads via the MindStudio host.
 *
 * These are actions that require interaction with the MindStudio platform
 * (the parent window that hosts the iframe). The file picker uses
 * postMessage to communicate with the host; file uploads go directly
 * to the API.
 *
 * ## `platform.requestFile(options?)`
 *
 * Opens the MindStudio asset library / file picker. The user can upload
 * a new file or choose from their existing assets. Returns the CDN URL.
 *
 * Uses the postMessage callback token pattern:
 * 1. SDK generates a unique callback token
 * 2. Sends `{ action: 'requestFile', type?, callbackToken }` to parent
 * 3. Parent opens the asset library modal
 * 4. User picks a file → parent sends `{ action: 'callback', callbackToken, result: { url } }`
 * 5. SDK resolves the promise with the URL
 *
 * ## `platform.uploadFile(file)`
 *
 * Uploads a file directly to the MindStudio CDN without opening a picker.
 * Uses a direct HTTP POST with the session token — no postMessage needed.
 *
 * @example
 * ```ts
 * import { platform } from '@mindstudio-ai/interface';
 *
 * // Open the file picker
 * const url = await platform.requestFile({ type: 'image' });
 *
 * // Upload directly
 * const file = document.querySelector('input[type=file]').files[0];
 * const uploadedUrl = await platform.uploadFile(file);
 * ```
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';
import type { RequestFileOptions } from './types.js';

/**
 * The platform namespace — file picker and upload actions.
 */
export const platform = {
  /**
   * Open the MindStudio asset library / file picker.
   *
   * Returns the CDN URL of the selected or uploaded file.
   * Throws if the user cancels the picker.
   *
   * @param options - Optional filter by file type
   * @returns CDN URL of the selected file
   *
   * @example
   * ```ts
   * const imageUrl = await platform.requestFile({ type: 'image' });
   * const anyFile = await platform.requestFile();
   * ```
   */
  requestFile(options?: RequestFileOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const callbackToken = crypto.randomUUID();

      // Listen for the callback from the parent window
      const listener = ({ data }: MessageEvent) => {
        if (
          data?.action === 'callback' &&
          data?.callbackToken === callbackToken
        ) {
          window.removeEventListener('message', listener);

          const url = data.result?.url;
          if (url) {
            resolve(url);
          } else {
            reject(
              new MindStudioInterfaceError(
                'File picker was cancelled.',
                'file_picker_cancelled',
              ),
            );
          }
        }
      };

      window.addEventListener('message', listener);

      // Send the request to the parent window
      window.parent.postMessage(
        {
          action: 'requestFile',
          type: options?.type,
          callbackToken,
        },
        '*',
      );
    });
  },

  /**
   * Upload a file directly to the MindStudio CDN.
   *
   * Does not open a picker — use this when you already have a File
   * object (e.g. from a drag-and-drop or a custom file input).
   *
   * @param file - The File to upload
   * @returns CDN URL of the uploaded file
   *
   * @example
   * ```ts
   * const file = inputElement.files[0];
   * const url = await platform.uploadFile(file);
   * ```
   */
  async uploadFile(file: File): Promise<string> {
    const config = getConfig();
    const url = `${config.apiBaseUrl}/_internal/v2/apps/${config.appId}/upload`;

    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
      body: formData,
    });

    if (!res.ok) {
      throw new MindStudioInterfaceError(
        `File upload failed: ${res.status} ${res.statusText}`,
        'upload_error',
        res.status,
      );
    }

    const body = (await res.json()) as { url: string };
    return body.url;
  },
};
