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
// That token is cached in this tab's sessionStorage (see below) so a
// reload doesn't force you to reconnect, but it never touches localStorage
// and disappears the moment the tab or window is closed.
//
// Two different sign-in mechanics are used depending on device, see
// "Popup vs redirect sign-in" further down: GIS's own popup flow on
// desktop, and a hand-rolled full-page redirect on mobile browsers, where
// a backgrounded popup tab can get killed for memory before it's able to
// hand the token back.
//
// The OAuth Client ID is fixed at build time (DRIVE_CLIENT_ID below) and is
// not configurable at runtime. It's a public identifier, not a secret, so
// it's fine for it to live in client-side code or a public repo. Running
// your own copy on a different origin? Create a Web-application OAuth
// Client ID in Google Cloud Console, add your origin under "Authorized
// JavaScript origins", and replace the constant below.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * This deployment's Google OAuth Client ID (Web application type), authorized
 * for this site's origin. Vault always signs in with this ID: there is no
 * runtime override.
 */
export const DRIVE_CLIENT_ID = '400701752867-bq43ns7mbnric8apk5ktpt6vaftvmmc5.apps.googleusercontent.com';

/**
 * Earlier builds let people paste their own Client ID into a Settings panel
 * and kept it under this key. That override is gone, so the key is only ever
 * read to delete it (see `purgeLegacyClientIdOverride`).
 */
const LEGACY_CLIENT_ID_STORAGE_KEY = 'fitform:drive-client-id';

/** Removes any Client ID override saved by an earlier build so it can't linger in localStorage. */
export function purgeLegacyClientIdOverride(): void {
  try {
    localStorage.removeItem(LEGACY_CLIENT_ID_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode, blocked): nothing to purge */
  }
}

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

/**
 * sessionStorage key the current Drive access token is cached under.
 * sessionStorage (unlike localStorage) is scoped to this one tab/window and
 * is wiped automatically when it's closed, which keeps the token's
 * lifetime aligned with "this browsing session" rather than persisting it
 * indefinitely on disk.
 */
const TOKEN_STORAGE_KEY = 'fitform:drive-token';

/** Caches the current token in sessionStorage so a page reload can restore it. */
export function saveTokenToSession(token: DriveToken): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
  } catch {
    /* storage unavailable (private mode, blocked, quota) — token just won't survive a reload */
  }
}

/** Reads back a cached token, if any, discarding it if it's already expired. */
export function loadTokenFromSession(): DriveToken | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!raw) return null;
    const token = JSON.parse(raw) as DriveToken;
    if (!token?.accessToken || typeof token.expiresAt !== 'number' || token.expiresAt <= Date.now()) {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** Clears the cached token, e.g. on sign-out. */
export function clearTokenFromSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ── Popup vs redirect sign-in ───────────────────────────────────────────
//
// GIS's default popup flow works by opening a second window/tab for
// accounts.google.com and posting the result back to the opener once the
// user finishes there. On desktop that's a real popup window and it's
// fine. On Android Chromium browsers it's typically just a second
// *background tab* — and on a low-RAM device, Chromium can reclaim that
// backgrounded FitForm tab's memory while the user is still on Google's
// page. When Google then tries to hand the token back, there's no live
// JavaScript left in the original tab to receive it: reopening the tab
// just triggers a fresh reload, and the whole sign-in silently goes
// nowhere. Nothing this app does can stop Chromium from discarding a
// backgrounded tab.
//
// The fix is to never background the tab in the first place: on mobile,
// sign-in below does a full top-level `window.location` redirect instead
// of opening a popup. The *same* tab navigates to Google and back, so
// there's no separate tab sitting in the background for the OS to kill —
// the tab does fully unload and reload, but everything it needs to finish
// the flow (the access token) comes back encoded in the URL itself
// (`consumeRedirectToken`, called on startup), not in any in-memory JS
// state that a reload would destroy.
//
// This does require the redirect URI below to be registered under
// "Authorized redirect URIs" for this OAuth Client ID in Google Cloud
// Console (Authorized *JavaScript origins*, already needed for the popup
// flow, is a separate list and isn't enough on its own).

/** True for mobile browsers, where sign-in uses a redirect instead of a popup (see above). */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** Where Google sends the browser back to after a redirect sign-in. Must be an exact match of an "Authorized redirect URI" on the OAuth Client. */
function driveRedirectUri(): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}`;
}

/** sessionStorage key for the CSRF nonce stashed just before redirecting to Google, checked again on the way back. */
const OAUTH_STATE_KEY = 'fitform:drive-oauth-state';

/**
 * Starts the redirect sign-in flow: navigates the whole tab to Google's
 * OAuth consent screen. Does not return a value — by the time Google
 * responds, this page has been replaced (and, after the round trip,
 * reloaded fresh). The response is picked back up by `consumeRedirectToken`
 * on the next startup.
 */
export function startRedirectSignIn(clientId: string): void {
  const state = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  try {
    sessionStorage.setItem(OAUTH_STATE_KEY, state);
  } catch {
    /* if sessionStorage is unavailable, the state check on return is just skipped */
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: driveRedirectUri(),
    response_type: 'token',
    scope: DRIVE_FILE_SCOPE,
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

export type RedirectTokenResult = { kind: 'token'; token: DriveToken } | { kind: 'error'; message: string } | { kind: 'none' };

/**
 * Call once on startup, before anything else touches Drive state. If the
 * current URL is Google redirecting back from `startRedirectSignIn` (its
 * response comes back as a URL fragment, e.g. `#access_token=...`), this
 * parses it, checks the CSRF state matches what was stashed before
 * redirecting, and — either way — strips the fragment from the address
 * bar immediately so a later page refresh can't re-process a stale one.
 */
export function consumeRedirectToken(): RedirectTokenResult {
  if (typeof window === 'undefined' || !window.location.hash) return { kind: 'none' };
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  if (!params.has('access_token') && !params.has('error')) return { kind: 'none' };

  // Scrub the fragment regardless of outcome, before anything else can throw.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

  let expectedState: string | null = null;
  try {
    expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    /* if sessionStorage is unavailable, the state check below is skipped */
  }

  const error = params.get('error');
  if (error) {
    return { kind: 'error', message: params.get('error_description') || error };
  }

  const returnedState = params.get('state');
  if (expectedState && returnedState !== expectedState) {
    return { kind: 'error', message: 'Sign-in response could not be verified — please try connecting again.' };
  }

  const accessToken = params.get('access_token');
  if (!accessToken) return { kind: 'error', message: 'Google did not return an access token.' };
  const expiresInSec = Number(params.get('expires_in') ?? 3600);

  return { kind: 'token', token: { accessToken, expiresAt: Date.now() + expiresInSec * 1000 } };
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
