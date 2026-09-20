import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FileImage, FileText, X } from 'lucide-react';
import { formatBytes } from '../state/pipeline';
import { Button } from './ui/button';

interface Props {
  file: File | null;
  onFile: (file: File) => void;
  onClear: () => void;
}

const ACCEPT = '.jpg,.jpeg,.png,.webp,.bmp,.tga,.pdf,image/*,application/pdf';

export function Dropzone({ file, onFile, onClear }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  if (file) {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    return (
      <div className="file-row">
        <div className="file-row__icon">{isPdf ? <FileText size={16} /> : <FileImage size={16} />}</div>
        <div className="file-row__text">
          <div className="file-row__name">{file.name}</div>
          <div className="file-row__meta">{formatBytes(file.size)}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()}>
          Change
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClear} aria-label="Remove file">
          <X size={15} />
        </Button>
        <input ref={inputRef} type="file" accept={ACCEPT} onChange={(e) => handleFiles(e.target.files)} />
      </div>
    );
  }

  return (
    <div
      className={`dropzone${dragOver ? ' dropzone--active' : ''}`}
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
        <UploadCloud size={26} />
      </div>
      <p className="dropzone__title">Drop a photo or PDF here, or click to browse</p>
      <p className="dropzone__hint">JPG · PNG · WebP · BMP · TGA · PDF</p>
      <input ref={inputRef} type="file" accept={ACCEPT} onChange={(e) => handleFiles(e.target.files)} />
    </div>
  );
}
