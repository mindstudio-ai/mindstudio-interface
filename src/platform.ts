/**
 * Platform actions — file uploads via presigned S3 POST.
 *
 * Uses the session token from `window.__MINDSTUDIO__` to request a
 * presigned upload URL from the platform, then uploads directly to S3.
 * Returns the public CDN URL.
 *
 * @example
 * ```ts
 * import { platform } from '@mindstudio-ai/interface';
 *
 * const file = document.querySelector('input[type=file]').files[0];
 * const url = await platform.uploadFile(file);
 *
 * // With progress and abort
 * const controller = new AbortController();
 * const url = await platform.uploadFile(file, {
 *   onProgress: (fraction) => console.log(`${Math.round(fraction * 100)}%`),
 *   signal: controller.signal,
 * });
 * ```
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';

/**
 * Options for `platform.uploadFile()`.
 */
export interface UploadFileOptions {
  /** Called with upload progress as a fraction from 0 to 1. */
  onProgress?: (fraction: number) => void;

  /** AbortSignal to cancel the upload. */
  signal?: AbortSignal;
}

/**
 * An upload token minted by an app's backend (`Store.createUploadToken` in
 * `@mindstudio-ai/agent`) and passed to {@link platform.upload}. Opaque — carry
 * it from the backend response straight into `platform.upload(token, file)`.
 */
export interface UploadToken {
  /** The object key the upload lands at. */
  key: string;
  /** The URL the file will be readable at once uploaded. */
  url: string;
  /** The scoped presigned POST the browser submits to. */
  upload: { url: string; fields: Record<string, string> };
}

/**
 * The platform namespace — file upload actions.
 */
export const platform = {
  /**
   * Upload a file to the MindStudio CDN.
   *
   * Requests a presigned upload URL from the platform, then uploads
   * the file directly to S3. Returns the public CDN URL.
   *
   * @param file - The File to upload
   * @param options - Optional progress callback and abort signal
   * @returns CDN URL of the uploaded file
   *
   * @example
   * ```ts
   * const url = await platform.uploadFile(file);
   *
   * // With progress
   * const url = await platform.uploadFile(file, {
   *   onProgress: (f) => setProgress(f),
   * });
   *
   * // With abort
   * const controller = new AbortController();
   * const url = await platform.uploadFile(file, {
   *   signal: controller.signal,
   * });
   * // controller.abort() to cancel
   * ```
   */
  async uploadFile(file: File, options?: UploadFileOptions): Promise<string> {
    const config = getConfig();
    const { onProgress, signal } = options ?? {};

    // Check if already aborted
    signal?.throwIfAborted();

    // Step 1: Get presigned upload URL
    const presignUrl = '/_/generate-upload-request';
    const presignRes = await fetch(presignUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
      }),
      signal,
    });

    if (!presignRes.ok) {
      throw new MindStudioInterfaceError(
        `Upload presign failed: ${presignRes.status} ${presignRes.statusText}`,
        'upload_error',
        presignRes.status,
      );
    }

    const { uploadUrl, uploadFields, publicUrl } =
      (await presignRes.json()) as {
        uploadUrl: string;
        uploadFields: Record<string, string>;
        publicUrl: string;
      };

    // Step 2: Upload directly to S3
    const formData = new FormData();
    for (const [key, value] of Object.entries(uploadFields)) {
      formData.append(key, value);
    }
    formData.append('file', file); // must be last

    // Use XHR for upload progress (fetch doesn't support it)
    if (onProgress) {
      await xhrUpload(uploadUrl, formData, onProgress, signal);
      return publicUrl;
    }

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
      signal,
    });

    if (!uploadRes.ok) {
      throw new MindStudioInterfaceError(
        `File upload failed: ${uploadRes.status} ${uploadRes.statusText}`,
        'upload_error',
        uploadRes.status,
      );
    }

    return publicUrl;
  },

  /**
   * Upload a file with an {@link UploadToken} minted by the app's backend
   * (`Store.createUploadToken`). The file is POSTed **directly to storage** —
   * the bytes never pass through the platform — and the returned `{ key, url }`
   * is ready to render (`url` is a stable on-domain link the app can use in
   * `<img>` / `fetch` / `<a download>`).
   *
   * @example
   * ```ts
   * const token = await api.getUploadSlot({ contentType: file.type });
   * const { url } = await platform.upload(token, file, {
   *   onProgress: (f) => setProgress(f),
   * });
   * ```
   */
  async upload(
    token: UploadToken,
    file: File,
    options?: UploadFileOptions,
  ): Promise<{ key: string; url: string }> {
    const { onProgress, signal } = options ?? {};
    signal?.throwIfAborted();

    const formData = new FormData();
    for (const [key, value] of Object.entries(token.upload.fields)) {
      formData.append(key, value);
    }
    formData.append('file', file); // must be last

    if (onProgress) {
      await xhrUpload(token.upload.url, formData, onProgress, signal);
    } else {
      const res = await fetch(token.upload.url, {
        method: 'POST',
        body: formData,
        signal,
      });
      if (!res.ok) {
        throw new MindStudioInterfaceError(
          `File upload failed: ${res.status} ${res.statusText}`,
          'upload_error',
          res.status,
        );
      }
    }

    return { key: token.key, url: token.url };
  },
};

/**
 * Upload via XMLHttpRequest to get progress events.
 * Falls back from fetch because fetch upload streams don't support progress.
 */
function xhrUpload(
  url: string,
  formData: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(e.loaded / e.total);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(
          new MindStudioInterfaceError(
            `File upload failed: ${xhr.status} ${xhr.statusText}`,
            'upload_error',
            xhr.status,
          ),
        );
      }
    });

    xhr.addEventListener('error', () => {
      reject(
        new MindStudioInterfaceError(
          'File upload failed: network error',
          'upload_error',
        ),
      );
    });

    xhr.addEventListener('abort', () => {
      reject(new DOMException('Upload aborted', 'AbortError'));
    });

    // Wire up abort signal
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.open('POST', url);
    xhr.send(formData);
  });
}
