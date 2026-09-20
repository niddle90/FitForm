import { useCallback, useEffect, useRef, useState } from 'react';
import { createTokenClient, CLIENT_ID_STORAGE_KEY, type DriveToken, type TokenClientHandle } from './auth';
import {
  ensureVaultFolder,
  listFiles,
  uploadFile,
  downloadFile,
  deleteFile,
  renameFile,
  DriveApiError,
  type DriveFile,
} from './api';

export type DriveStatus = 'no-client-id' | 'signed-out' | 'connecting' | 'signed-in' | 'error';

export interface UploadTask {
  id: string;
  name: string;
  progress: number; // 0..1
  error?: string;
}

// Renew a bit before actual expiry so an in-flight action doesn't get cut off.
const RENEW_SKEW_MS = 60_000;

export function useDrive() {
  const [clientId, setClientIdState] = useState<string>(() => localStorage.getItem(CLIENT_ID_STORAGE_KEY) || '');
  const [status, setStatus] = useState<DriveStatus>(clientId ? 'signed-out' : 'no-client-id');
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploads, setUploads] = useState<UploadTask[]>([]);

  const tokenClientRef = useRef<TokenClientHandle | null>(null);
  const tokenRef = useRef<DriveToken | null>(null);
  const folderIdRef = useRef<string | null>(null);
  const renewTimerRef = useRef<number | null>(null);

  const setClientId = useCallback((id: string) => {
    const trimmed = id.trim();
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, trimmed);
    setClientIdState(trimmed);
    setStatus(trimmed ? 'signed-out' : 'no-client-id');
    setError(null);
  }, []);

  const scheduleRenew = useCallback((token: DriveToken) => {
    if (renewTimerRef.current) window.clearTimeout(renewTimerRef.current);
    const delay = Math.max(token.expiresAt - Date.now() - RENEW_SKEW_MS, 5_000);
    renewTimerRef.current = window.setTimeout(async () => {
      try {
        if (!tokenClientRef.current) return;
        const renewed = await tokenClientRef.current.requestToken({ silent: true });
        tokenRef.current = renewed;
        scheduleRenew(renewed);
      } catch {
        // Silent renewal failed (session expired, or the browser blocked
        // the background request) — fall back to asking the person to
        // reconnect rather than failing their next action opaquely.
        setStatus('signed-out');
        setError('Your Google session needs to be refreshed — click Connect again.');
      }
    }, delay);
  }, []);

  const refreshFiles = useCallback(async () => {
    if (!tokenRef.current || !folderIdRef.current) return;
    setLoadingFiles(true);
    try {
      const list = await listFiles(tokenRef.current.accessToken, folderIdRef.current);
      setFiles(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your files.');
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  const connect = useCallback(async () => {
    if (!clientId) {
      setStatus('no-client-id');
      return;
    }
    setStatus('connecting');
    setError(null);
    try {
      if (!tokenClientRef.current) {
        tokenClientRef.current = await createTokenClient(clientId);
      }
      const token = await tokenClientRef.current.requestToken();
      tokenRef.current = token;
      scheduleRenew(token);
      const folderId = await ensureVaultFolder(token.accessToken);
      folderIdRef.current = folderId;
      setStatus('signed-in');
      await refreshFiles();
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : 'Could not connect to Google Drive.');
    }
  }, [clientId, refreshFiles, scheduleRenew]);

  const disconnect = useCallback(() => {
    if (renewTimerRef.current) window.clearTimeout(renewTimerRef.current);
    tokenClientRef.current?.signOut(tokenRef.current?.accessToken ?? null);
    tokenRef.current = null;
    folderIdRef.current = null;
    setFiles([]);
    setStatus('signed-out');
  }, []);

  useEffect(
    () => () => {
      if (renewTimerRef.current) window.clearTimeout(renewTimerRef.current);
    },
    [],
  );

  const withToken = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    if (!tokenRef.current) throw new Error('Not connected to Google Drive.');
    try {
      return await fn(tokenRef.current.accessToken);
    } catch (e) {
      if (e instanceof DriveApiError && e.status === 401 && tokenClientRef.current) {
        // Token died earlier than expected — try one silent renew, then retry once.
        const renewed = await tokenClientRef.current.requestToken({ silent: true });
        tokenRef.current = renewed;
        scheduleRenew(renewed);
        return fn(renewed.accessToken);
      }
      throw e;
    }
  }, [scheduleRenew]);

  const upload = useCallback(
    async (fileList: FileList | File[]) => {
      if (!folderIdRef.current) return;
      const folderId = folderIdRef.current;
      const list = Array.from(fileList);
      const tasks: UploadTask[] = list.map((f) => ({ id: `${f.name}-${f.size}-${Date.now()}-${Math.random()}`, name: f.name, progress: 0 }));
      setUploads((u) => [...u, ...tasks]);

      await Promise.all(
        list.map(async (file, i) => {
          const taskId = tasks[i].id;
          try {
            await withToken((token) =>
              uploadFile(token, folderId, file, (fraction) => {
                setUploads((u) => u.map((t) => (t.id === taskId ? { ...t, progress: fraction } : t)));
              }),
            );
          } catch (e) {
            setUploads((u) => u.map((t) => (t.id === taskId ? { ...t, error: e instanceof Error ? e.message : 'Upload failed' } : t)));
            return;
          }
          setUploads((u) => u.filter((t) => t.id !== taskId));
        }),
      );
      await refreshFiles();
    },
    [refreshFiles, withToken],
  );

  const download = useCallback(
    async (file: DriveFile) => {
      const blob = await withToken((token) => downloadFile(token, file.id));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    [withToken],
  );

  // Fetches a vault file's bytes without triggering a save-as download —
  // what "Open in Studio" uses to hand the file straight to the pipeline.
  const fetchBlob = useCallback(
    async (file: DriveFile): Promise<File> => {
      const blob = await withToken((token) => downloadFile(token, file.id));
      return new File([blob], file.name, { type: file.mimeType || blob.type });
    },
    [withToken],
  );

  // The other direction: hands the studio's processed output straight to
  // the vault, reusing the same upload path files dropped in the vault go
  // through, so it shows up in the list (and gets its progress tracked)
  // exactly the same way.
  const uploadBytes = useCallback(
    async (data: Uint8Array, filename: string, mime: string) => {
      if (!folderIdRef.current) throw new Error('Not connected to Google Drive.');
      const file = new File([new Uint8Array(data)], filename, { type: mime });
      await upload([file]);
    },
    [upload],
  );

  const remove = useCallback(
    async (file: DriveFile) => {
      await withToken((token) => deleteFile(token, file.id));
      setFiles((f) => f.filter((x) => x.id !== file.id));
    },
    [withToken],
  );

  const rename = useCallback(
    async (file: DriveFile, name: string) => {
      await withToken((token) => renameFile(token, file.id, name));
      setFiles((f) => f.map((x) => (x.id === file.id ? { ...x, name } : x)));
    },
    [withToken],
  );

  return {
    clientId,
    setClientId,
    status,
    error,
    files,
    loadingFiles,
    uploads,
    connect,
    disconnect,
    refreshFiles,
    upload,
    uploadBytes,
    download,
    fetchBlob,
    remove,
    rename,
  };
}
