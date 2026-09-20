// ── Google Drive auth (fully client-side, no backend) ──────────────────────
//
// This app never sees your other Drive files. It asks Google for the
// `drive.file` scope only — the narrowest scope Drive offers — which grants
// access to exactly two categories of file: (1) files this app creates
// itself, and (2) files you explicitly pick via Google's file picker. Every
// other file in your Drive stays invisible to it, by Google's own
// enforcement server-side, not by convention on our end.
//
// There's no server anywhere in this flow. Sign-in uses Google Identity
// Services' token client (GIS), which runs entirely in the browser and
// hands back a short-lived OAuth access token (no client secret involved —
// public single-page apps like this one are never supposed to hold one).
// That token lives only in memory for the life of the tab; nothing is
// persisted to localStorage. Reload the page and you sign in again.
//
// To use this yourself, you need your own OAuth 2.0 Client ID from Google
// Cloud Console (APIs & Services → Credentials → Create Credentials →
// OAuth client ID → Application type "Web application"), with your GitHub
// Pages origin (e.g. https://you.github.io) added under "Authorized
// JavaScript origins". A Client ID is a public identifier, not a secret —
// it's fine for it to live in client-side code or a public repo.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const CLIENT_ID_STORAGE_KEY = 'fitform:drive-client-id';

let gisLoadPromise: Promise<void> | null = null;

/** Loads the Google Identity Services script once, idempotently. */
function loadGis(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoadPromise) return gisLoadPromise;

  gisLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity Services')));
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

export interface DriveToken {
  accessToken: string;
  /** ms epoch when this token stops being usable */
  expiresAt: number;
}

export type TokenClientHandle = {
  /** Opens Google's consent screen (or an account chooser). Resolves once a token is granted, rejects on failure/close-without-consent. */
  requestToken: (opts?: { silent?: boolean }) => Promise<DriveToken>;
  /** Revokes the current token with Google, if any, and forgets it locally. */
  signOut: (token: string | null) => void;
};

/**
 * Builds a token client bound to a given OAuth Client ID. Call
 * `requestToken()` from a user gesture (button click) the first time —
 * browsers block the consent popup otherwise. Subsequent calls with
 * `{ silent: true }` try to renew without any UI, which succeeds only if
 * the browser still has an active Google session and doesn't block the
 * background request (some browsers' cross-site storage partitioning can
 * prevent this — if silent renewal fails, fall back to asking the person
 * to reconnect).
 */
export async function createTokenClient(clientId: string): Promise<TokenClientHandle> {
  await loadGis();
  const google = (window as any).google;
  if (!google?.accounts?.oauth2) {
    throw new Error('Google Identity Services failed to load. Check your network/ad-blocker and try again.');
  }

  let resolveCurrent: ((t: DriveToken) => void) | null = null;
  let rejectCurrent: ((e: Error) => void) | null = null;

  const client = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_FILE_SCOPE,
    callback: (resp: any) => {
      if (resp.error) {
        rejectCurrent?.(new Error(resp.error_description || resp.error));
        return;
      }
      const expiresInSec = Number(resp.expires_in ?? 3600);
      resolveCurrent?.({
        accessToken: resp.access_token,
        expiresAt: Date.now() + expiresInSec * 1000,
      });
    },
    error_callback: (err: any) => {
      rejectCurrent?.(new Error(err?.message || 'Sign-in was cancelled or blocked.'));
    },
  });

  return {
    requestToken(opts) {
      return new Promise<DriveToken>((resolve, reject) => {
        resolveCurrent = resolve;
        rejectCurrent = reject;
        client.requestAccessToken({ prompt: opts?.silent ? '' : 'consent' });
      });
    },
    signOut(token) {
      if (token) {
        try {
          google.accounts.oauth2.revoke(token, () => {});
        } catch {
          /* best effort */
        }
      }
    },
  };
}
