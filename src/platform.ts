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
 * ```
 */

import { getConfig } from './config.js';
import { MindStudioInterfaceError } from './errors.js';

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

    // Step 1: Get presigned upload URL
    const presignUrl = `${config.apiBaseUrl}/_internal/v2/apps/${config.appId}/generate-upload-request`;
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

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
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
};
