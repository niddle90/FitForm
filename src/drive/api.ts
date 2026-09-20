// ── Drive REST v3 helpers ────────────────────────────────────────────────
// Plain `fetch` calls against https://www.googleapis.com/drive/v3/... —
// no Google API client library needed. Every call carries the caller's
// short-lived OAuth access token as a Bearer header; nothing here ever
// touches a client secret because there isn't one to touch.

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const VAULT_FOLDER_NAME = 'FitForm Vault';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Drive returns this as a string
  modifiedTime: string;
  iconLink?: string;
  thumbnailLink?: string;
}

export class DriveApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'DriveApiError';
  }
}

async function driveFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body?.error?.message || message;
    } catch {
      /* ignore */
    }
    throw new DriveApiError(res.status, message);
  }
  return res;
}

/**
 * Finds (or creates, on first use) the single app folder this app keeps all
 * its documents in. Because we only hold the `drive.file` scope, a plain
 * folder search (`mimeType = 'application/vnd.google-apps.folder'`) would
 * find nothing — the scope doesn't grant visibility into folders this app
 * didn't create. So the folder's id is cached locally after creation; if
 * that cache is missing (new browser, cleared storage) we simply create a
 * fresh one. Harmless if it results in more than one "FitForm Vault" folder
 * existing over time — each is independently fine to use.
 */
export async function ensureVaultFolder(token: string): Promise<string> {
  const cached = localStorage.getItem('fitform:vault-folder-id');
  if (cached) {
    // Verify it still exists / is still accessible before trusting it.
    const res = await fetch(`${DRIVE_API}/files/${cached}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const body = await res.json();
      if (!body.trashed) return cached;
    }
  }

  const res = await driveFetch(token, `${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: VAULT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const body = await res.json();
  localStorage.setItem('fitform:vault-folder-id', body.id);
  return body.id;
}

export async function listFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink)',
    orderBy: 'modifiedTime desc',
    pageSize: '200',
    spaces: 'drive',
  });
  const res = await driveFetch(token, `${DRIVE_API}/files?${params.toString()}`);
  const body = await res.json();
  return body.files || [];
}

export async function uploadFile(
  token: string,
  folderId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<DriveFile> {
  const metadata = { name: file.name, parents: [folderId] };

  // Uses a raw XHR (not fetch) purely so we get upload progress events —
  // fetch's request-body streaming/progress support isn't reliable enough
  // across browsers yet for a good progress bar.
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,iconLink,thumbnailLink`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        let message = xhr.statusText;
        try {
          message = JSON.parse(xhr.responseText)?.error?.message || message;
        } catch {
          /* ignore */
        }
        reject(new DriveApiError(xhr.status, message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(form);
  });
}

export async function downloadFile(token: string, fileId: string): Promise<Blob> {
  const res = await driveFetch(token, `${DRIVE_API}/files/${fileId}?alt=media`);
  return res.blob();
}

export async function deleteFile(token: string, fileId: string): Promise<void> {
  await driveFetch(token, `${DRIVE_API}/files/${fileId}`, { method: 'DELETE' });
}

export async function renameFile(token: string, fileId: string, name: string): Promise<void> {
  await driveFetch(token, `${DRIVE_API}/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}
