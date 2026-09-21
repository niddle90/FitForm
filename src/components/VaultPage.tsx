import { useCallback, useMemo, useRef, useState } from 'react';
import {
  CloudUpload,
  File as FileIcon,
  FileImage,
  FileText,
  Download,
  Trash2,
  Pencil,
  RefreshCw,
  LogOut,
  Loader2,
  AlertTriangle,
  Wrench,
  FolderLock,
  Cloud,
  Unplug,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { formatBytes } from '../state/pipeline';
import type { DriveFile } from '../drive/api';
import type { useDrive } from '../drive/useDrive';
import { Button } from './ui/button';
import { InfoTip } from './InfoTip';
import { LegalLinks, PRIVACY_URL, TERMS_URL } from './LegalLinks';
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

type FileKind = 'image' | 'pdf' | 'other';

function fileKind(f: DriveFile): FileKind {
  if (f.mimeType.startsWith('image/')) return 'image';
  if (f.mimeType === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  return 'other';
}

const KIND_ICON = { image: FileImage, pdf: FileText, other: FileIcon } as const;

interface Props {
  drive: ReturnType<typeof useDrive>;
  /** Downloads a vault file's bytes and hands it straight to the Studio tab. */
  onOpenInStudio: (file: File) => void;
}

/** What a signed-out visitor sees: what the Vault is, what it can and can't touch, and one clear way in. */
function VaultIntro({ drive }: { drive: Props['drive'] }) {
  const connecting = drive.status === 'connecting';
  return (
    <section className="vault-intro" aria-labelledby="vault-intro-title">
      <div className="vault-intro__badge">
        <Lock size={24} strokeWidth={2.25} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 id="vault-intro-title" className="text-balance text-2xl leading-tight text-foreground">
          Keep your documents in your own Drive
        </h2>
        <p className="vault-intro__lead">
          Save the photos and PDFs you keep needing in one private folder, then open any of them in Studio to resize or convert.
        </p>
      </div>

      <ul className="vault-points">
        <li>
          <span className="vault-points__icon">
            <FolderLock size={15} />
          </span>
          <span>
            <strong>One folder, nothing else</strong>
            FitForm can only see the “FitForm Vault” folder it creates. The rest of your Drive stays invisible to it.
          </span>
        </li>
        <li>
          <span className="vault-points__icon">
            <Cloud size={15} />
          </span>
          <span>
            <strong>Stored by Google, not by us</strong>
            Files go straight from your browser to your Drive. FitForm has no server to keep them on.
          </span>
        </li>
        <li>
          <span className="vault-points__icon">
            <Unplug size={15} />
          </span>
          <span>
            <strong>Leave whenever you like</strong>
            Disconnect here, or revoke access from your Google Account settings.
          </span>
        </li>
      </ul>

      <div className="flex w-full flex-col items-center gap-2.5">
        <Button size="lg" className="w-full sm:w-auto sm:min-w-56" onClick={drive.connect} disabled={connecting}>
          {connecting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Connecting…
            </>
          ) : (
            'Continue with Google'
          )}
        </Button>
        <p className="vault-consent">
          By continuing you agree to the{' '}
          <a href={TERMS_URL} target="_blank" rel="noopener">
            Terms
          </a>{' '}
          and{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </section>
  );
}

export function VaultPage({ drive, onOpenInStudio }: Props) {
  const [dragOver, setDragOver] = useState(false);
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

  const signedIn = drive.status === 'signed-in';
  const showIntro = drive.status === 'signed-out' || drive.status === 'connecting' || drive.status === 'error';

  const summary = useMemo(() => {
    const n = drive.files.length;
    const total = drive.files.reduce((sum, f) => sum + (f.size ? Number(f.size) : 0), 0);
    if (n === 0) return 'No files yet';
    return `${n} ${n === 1 ? 'file' : 'files'}${total > 0 ? ` · ${formatBytes(total)}` : ''}`;
  }, [drive.files]);

  return (
    <div className="vault mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      {drive.error && (
        <div className="callout callout--error" role="alert">
          <AlertTriangle size={15} className="mt-px shrink-0" />
          <span>{drive.error}</span>
        </div>
      )}

      {showIntro && <VaultIntro drive={drive} />}

      {signedIn && (
        <>
          <header className="vault-bar">
            <div className="vault-bar__icon">
              <FolderLock size={20} strokeWidth={2} />
            </div>
            <div className="vault-bar__text">
              <h2 className="vault-bar__title">FitForm Vault</h2>
              <p className="vault-bar__sub">
                <span className="truncate">{summary}</span>
              </p>
            </div>
            <div className="vault-bar__actions">
              <Button
                variant="outline"
                size="icon"
                onClick={() => drive.refreshFiles()}
                aria-label="Refresh files"
                title="Refresh files"
              >
                <RefreshCw size={15} className={drive.loadingFiles ? 'animate-spin' : ''} />
              </Button>
              {/* Label collapses to an icon on phones: the bar has no room for both it and the title. */}
              <Button variant="outline" className="max-sm:w-9 max-sm:px-0" onClick={drive.disconnect} aria-label="Disconnect Google Drive" title="Disconnect">
                <LogOut size={14} />
                <span className="max-sm:hidden">Disconnect</span>
              </Button>
            </div>
          </header>

          <div
            className={`dropzone dropzone--compact${dragOver ? ' dropzone--active' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Upload files to your vault"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
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
            <p className="dropzone__title">{dragOver ? 'Drop to upload' : 'Drop files here, or click to upload'}</p>
            <p className="dropzone__hint">Any file type. They’re saved to your FitForm Vault folder.</p>
            <input ref={inputRef} type="file" multiple onChange={(e) => handleFiles(e.target.files)} />
          </div>

          {drive.uploads.length > 0 && (
            <div className="flex flex-col gap-2" aria-live="polite">
              {drive.uploads.map((u) => (
                <div className={`upload-row${u.error ? ' upload-row--error' : ''}`} key={u.id}>
                  <span className="upload-row__name">{u.name}</span>
                  {u.error ? (
                    <span className="upload-row__error">{u.error}</span>
                  ) : (
                    <Progress value={Math.round(u.progress * 100)} />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {drive.loadingFiles && drive.files.length === 0 ? (
              <>
                {[0, 1, 2].map((i) => (
                  <div className="file-row file-row--skeleton" key={i} aria-hidden="true">
                    <div className="file-row__icon" />
                    <div className="flex flex-1 flex-col gap-2">
                      <div className="h-3 w-2/5 rounded bg-muted" />
                      <div className="h-2.5 w-1/4 rounded bg-muted" />
                    </div>
                  </div>
                ))}
                <span className="sr-only">Loading your files…</span>
              </>
            ) : drive.files.length === 0 ? (
              <div className="empty-state vault-empty">
                <FolderLock size={26} className="text-muted-foreground" />
                <p className="font-semibold text-foreground">Your vault is empty</p>
                <p>Drop a file above and it will show up here, ready to open in Studio.</p>
              </div>
            ) : (
              drive.files.map((f) => {
                const kind = fileKind(f);
                const KindIcon = KIND_ICON[kind];
                const hasThumb = !!f.thumbnailLink && kind === 'image';
                return (
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
                      <div className={`file-row__icon file-row__icon--${kind}${hasThumb ? ' file-row__icon--thumb' : ''}`}>
                        {hasThumb ? <img src={f.thumbnailLink} alt="" loading="lazy" /> : <KindIcon size={18} />}
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
                          <span>{f.size ? formatBytes(Number(f.size)) : '–'}</span>
                          <span className="file-row__sep" aria-hidden="true" />
                          <span>{formatDate(f.modifiedTime)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="file-row__actions">
                      <Button
                        variant="outline"
                        size="sm"
                        className="file-row__studio"
                        onClick={() => handleOpenInStudio(f)}
                        disabled={openingId === f.id}
                      >
                        {openingId === f.id ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
                        Open in Studio
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => drive.download(f)} aria-label={`Download ${f.name}`} title="Download">
                        <Download size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          setRenamingId(f.id);
                          setRenameDraft(f.name);
                        }}
                        aria-label={`Rename ${f.name}`}
                        title="Rename"
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => setPendingDelete(f)}
                        aria-label={`Delete ${f.name}`}
                        title="Delete"
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {signedIn && (
        <footer className="vault-foot">
          <p className="vault-foot__note">
            <ShieldCheck size={15} className="shrink-0 text-primary" />
            <span>
              FitForm can only see its own <strong className="text-foreground">FitForm Vault</strong> folder.
              <InfoTip>Nothing else in your Google Drive is ever visible to this app.</InfoTip>
            </span>
          </p>
          <LegalLinks />
        </footer>
      )}

      <Dialog open={!!previewFile} onOpenChange={(o) => !o && setPreviewFile(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{previewFile?.name}</DialogTitle>
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
            <DialogTitle className="pr-8">Delete “{pendingDelete?.name}”?</DialogTitle>
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
              <Trash2 size={14} />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
