import { useCallback, useRef, useState } from 'react';
import {
  CloudUpload,
  File as FileIcon,
  Download,
  Trash2,
  Pencil,
  RefreshCw,
  LogOut,
  ShieldCheck,
  Settings,
  Loader2,
  AlertTriangle,
  Wrench,
  ExternalLink,
  HelpCircle,
} from 'lucide-react';
import { formatBytes } from '../state/pipeline';
import type { DriveFile } from '../drive/api';
import type { useDrive } from '../drive/useDrive';
import { Button } from './ui/button';
import { InfoTip } from './InfoTip';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/** Drive's thumbnailLink comes back sized for a file-row icon (~s220); swap in a bigger size for the popup preview. */
function largeThumb(url: string): string {
  return /=s\d+$/.test(url) ? url.replace(/=s\d+$/, '=s1600') : `${url}=s1600`;
}

interface Props {
  drive: ReturnType<typeof useDrive>;
  /** Downloads a vault file's bytes and hands it straight to the Studio tab. */
  onOpenInStudio: (file: File) => void;
}

export function VaultPage({ drive, onOpenInStudio }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(drive.status === 'no-client-id');
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const [clientIdDraft, setClientIdDraft] = useState(drive.clientId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<DriveFile | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<DriveFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (files && files.length) drive.upload(files);
    },
    [drive],
  );

  const handleOpenInStudio = useCallback(
    async (file: DriveFile) => {
      setOpeningId(file.id);
      try {
        const f = await drive.fetchBlob(file);
        onOpenInStudio(f);
      } catch {
        // drive.error already surfaces failures from withToken; nothing extra to do here.
      } finally {
        setOpeningId(null);
      }
    },
    [drive, onOpenInStudio],
  );

  const saveClientId = () => {
    drive.setClientId(clientIdDraft);
    setSettingsOpen(false);
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="vault mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-2.5 text-xs text-muted-foreground">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-primary" />
          <span className="inline-flex items-center gap-1">
            This site can only see its own <strong className="text-foreground">FitForm Vault</strong> folder in your Drive.
            <InfoTip>Nothing else in your Google Drive is ever visible to this app.</InfoTip>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {drive.status === 'signed-in' && (
            <Button variant="ghost" size="icon-sm" onClick={() => drive.refreshFiles()} aria-label="Refresh">
              <RefreshCw size={15} className={drive.loadingFiles ? 'animate-spin' : ''} />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setSettingsOpen((v) => !v)} aria-label="Settings">
            <Settings size={15} />
          </Button>
          {drive.status === 'signed-in' && (
            <Button variant="ghost" size="sm" onClick={drive.disconnect}>
              <LogOut size={13} />
              Disconnect
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-3 text-[11px] text-muted-foreground">
        <a href="/terms.html" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-foreground">
          Terms of Service
        </a>
        <a href="/privacy.html" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-foreground">
          Privacy Policy
        </a>
      </div>

      {settingsOpen && (
        <div className="section">
          <div className="section__head">
            <h3>Google Drive connection</h3>
          </div>
          <p className="hint-text">
            Paste a Google OAuth Client ID (Web application type).
            <InfoTip>A Client ID is a public identifier, not a secret, so it's safe to keep in client-side code.</InfoTip>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="xxxxxxxx.apps.googleusercontent.com"
              value={clientIdDraft}
              onChange={(e) => setClientIdDraft(e.target.value)}
              className="flex-1"
            />
            <div className="flex gap-2">
              <Button onClick={saveClientId} disabled={!clientIdDraft.trim()}>
                Save
              </Button>
              <Button variant="outline" onClick={() => setSetupGuideOpen(true)}>
                <HelpCircle size={14} />
                Setup guide
              </Button>
            </div>
          </div>
        </div>
      )}

      {drive.error && (
        <div className="callout callout--error">
          <AlertTriangle size={15} />
          <span>{drive.error}</span>
        </div>
      )}

      {drive.status === 'no-client-id' && !settingsOpen && (
        <div className="hero">
          <p className="hero__sub">Add a Google OAuth Client ID in settings to connect your personal cloud.</p>
          <Button variant="outline" onClick={() => setSetupGuideOpen(true)}>
            <HelpCircle size={14} />
            How do I get one?
          </Button>
        </div>
      )}

      {(drive.status === 'signed-out' || drive.status === 'connecting' || drive.status === 'error') && drive.clientId && (
        <div className="hero">
          <Button size="lg" onClick={drive.connect} disabled={drive.status === 'connecting'}>
            {drive.status === 'connecting' ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Connecting…
              </>
            ) : (
              'Continue with Google'
            )}
          </Button>
          <p className="hero__sub">You'll be asked to grant access to a single app-only Drive folder.</p>
          <p className="hero__sub text-xs">
            By continuing you agree to FitForm's{' '}
            <a href="/terms.html" target="_blank" rel="noopener" className="underline">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="/privacy.html" target="_blank" rel="noopener" className="underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      )}

      {drive.status === 'signed-in' && (
        <>
          <div
            className={`dropzone dropzone--compact${dragOver ? ' dropzone--active' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFiles(e.dataTransfer.files);
            }}
          >
            <div className="dropzone__icon">
              <CloudUpload size={22} />
            </div>
            <p className="dropzone__title">Drop files here, or click to upload to your vault</p>
            <input ref={inputRef} type="file" multiple onChange={(e) => handleFiles(e.target.files)} />
          </div>

          {drive.uploads.length > 0 && (
            <div className="flex flex-col gap-2">
              {drive.uploads.map((u) => (
                <div className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-xs" key={u.id}>
                  <span className="truncate font-medium text-foreground">{u.name}</span>
                  {u.error ? (
                    <span className="text-destructive">{u.error}</span>
                  ) : (
                    <Progress value={Math.round(u.progress * 100)} />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            {drive.loadingFiles && drive.files.length === 0 ? (
              <p className="hint-text hint-text--center">Loading your files…</p>
            ) : drive.files.length === 0 ? (
              <p className="hint-text hint-text--center">Your vault is empty. Upload something to get started.</p>
            ) : (
              drive.files.map((f) => (
                <div className="file-row" key={f.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    className="file-row__preview-trigger"
                    onClick={() => renamingId !== f.id && setPreviewFile(f)}
                    onKeyDown={(e) => {
                      if (renamingId === f.id) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setPreviewFile(f);
                      }
                    }}
                    aria-label={`Preview ${f.name}`}
                  >
                    <div className={`file-row__icon${f.thumbnailLink && f.mimeType.startsWith('image/') ? ' file-row__icon--thumb' : ''}`}>
                      {f.thumbnailLink && f.mimeType.startsWith('image/') ? (
                        <img src={f.thumbnailLink} alt="" loading="lazy" />
                      ) : (
                        <FileIcon size={16} />
                      )}
                    </div>
                    <div className="file-row__text">
                      {renamingId === f.id ? (
                        <Input
                          autoFocus
                          className="text-input--inline h-7"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter' && renameDraft.trim()) {
                              drive.rename(f, renameDraft.trim());
                              setRenamingId(null);
                            }
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          onBlur={() => setRenamingId(null)}
                        />
                      ) : (
                        <div className="file-row__name">{f.name}</div>
                      )}
                      <div className="file-row__meta">
                        {f.size ? formatBytes(Number(f.size)) : '–'} · {formatDate(f.modifiedTime)}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => handleOpenInStudio(f)}
                    aria-label="Open in Studio"
                    title="Open in Studio"
                    disabled={openingId === f.id}
                  >
                    {openingId === f.id ? <Loader2 size={15} className="animate-spin" /> : <Wrench size={15} />}
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => drive.download(f)} aria-label="Download">
                    <Download size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => {
                      setRenamingId(f.id);
                      setRenameDraft(f.name);
                    }}
                    aria-label="Rename"
                  >
                    <Pencil size={15} />
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive" onClick={() => setPendingDelete(f)} aria-label="Delete">
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </>
      )}

      <Dialog open={!!previewFile} onOpenChange={(o) => !o && setPreviewFile(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate">{previewFile?.name}</DialogTitle>
            <DialogDescription>
              {previewFile?.size ? formatBytes(Number(previewFile.size)) : ''}
              {previewFile && ` · ${formatDate(previewFile.modifiedTime)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="vault-preview">
            {previewFile?.thumbnailLink ? (
              <img src={largeThumb(previewFile.thumbnailLink)} alt={previewFile.name} className="vault-preview__img" />
            ) : (
              <div className="vault-preview__empty">
                <FileIcon size={28} />
                <span>No preview available</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => previewFile && drive.download(previewFile)}>
              <Download size={14} />
              Download
            </Button>
            <Button
              onClick={() => {
                if (previewFile) handleOpenInStudio(previewFile);
                setPreviewFile(null);
              }}
              disabled={openingId === previewFile?.id}
            >
              {openingId === previewFile?.id ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              Open in Studio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{pendingDelete?.name}"?</DialogTitle>
            <DialogDescription>This moves the file to your Google Drive trash. This can't be undone from here.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) drive.remove(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={setupGuideOpen} onOpenChange={setSetupGuideOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connecting your own Google Drive</DialogTitle>
            <DialogDescription>
              A one-time, five-minute setup in Google Cloud Console. The Client ID it gives you is a public identifier, safe to paste here.
            </DialogDescription>
          </DialogHeader>
          <ol className="flex flex-col gap-3 text-sm text-foreground">
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">1</span>
              <span>
                Open{' '}
                <a
                  href="https://console.cloud.google.com/projectcreate"
                  target="_blank"
                  rel="noreferrer"
                  className="link-btn inline-flex"
                >
                  Google Cloud Console <ExternalLink size={11} />
                </a>{' '}
                and create a new project (or pick an existing one).
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">2</span>
              <span>
                Under <strong>APIs &amp; Services &gt; Library</strong>, search for and enable the <strong>Google Drive API</strong>.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">3</span>
              <span>
                Under <strong>APIs &amp; Services &gt; OAuth consent screen</strong>, choose <strong>External</strong> and fill in an app
                name and your email.
                <InfoTip>
                  While it's in "Testing" mode, add your own Google account under <strong>Test users</strong>, otherwise Google will block
                  sign-in with an "app not verified" error.
                </InfoTip>
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">4</span>
              <span>
                Under <strong>APIs &amp; Services &gt; Credentials &gt; Create Credentials &gt; OAuth client ID</strong>, pick{' '}
                <strong>Web application</strong>. Under <strong>Authorized JavaScript origins</strong>, add this page's exact
                origin{origin ? ':' : ' (shown while the app is running).'}
                {origin && (
                  <code className="mt-1 block w-full break-all rounded-md bg-secondary px-2 py-1 font-mono text-xs text-foreground">{origin}</code>
                )}
                <InfoTip>
                  Just the scheme and host, plus port in dev. No path, no trailing slash. Leave "Authorized redirect URIs" empty since this flow
                  never redirects.
                </InfoTip>
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">5</span>
              <span>Copy the Client ID it generates (ends in <code className="font-mono text-xs">.apps.googleusercontent.com</code>) and paste it into the field above.</span>
            </li>
          </ol>
          <p className="hint-text">
            Sign-in failing right after adding a domain?
            <InfoTip>Origins can take a few minutes to propagate on Google's side. Wait a bit and retry before assuming it's misconfigured.</InfoTip>
          </p>
          <DialogFooter>
            <Button onClick={() => setSetupGuideOpen(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
