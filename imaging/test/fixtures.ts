import { createCanvas } from '@napi-rs/canvas';

/** A synthetic "photo" — gradient + shapes + text, at a realistic snapshot resolution. */
export async function makeSyntheticPhotoJpeg(width = 1600, height = 1200, quality = 92): Promise<Uint8Array> {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2b6cb0');
  gradient.addColorStop(0.5, '#ecc94b');
  gradient.addColorStop(1, '#c53030');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Add some higher-frequency detail so JPEG compression actually has work
  // to do (a flat gradient alone compresses trivially, which would make
  // compress's search loop degenerate).
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.5)`;
    const x = (i * 97) % width;
    const y = (i * 61) % height;
    ctx.fillRect(x, y, 12, 12);
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '48px sans-serif';
  ctx.fillText('imaging fixture', 40, height - 40);

  const buf = await canvas.encode('jpeg', quality);
  return new Uint8Array(buf);
}

/**
 * A hand-written multi-page PDF with a distinct colored square per page and
 * a distinct page size for page 2 (to also exercise pdfToImages's per-page zoom
 * calculation, not just its page-iteration logic).
 */
export function makeTestPdf(): Uint8Array {
  const pages = [
    { w: 200, h: 200, rgb: [1, 0, 0] as const }, // page 1: red, square
    { w: 300, h: 150, rgb: [0, 0, 1] as const }, // page 2: blue, wide
  ];

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const write = (s: string) => {
    const b = enc.encode(s);
    chunks.push(b);
    len += b.length;
  };
  const offset = () => len;

  const offsets: number[] = [0];
  let objPtr = 1;

  write('%PDF-1.4\n');

  offsets[objPtr++] = offset();
  write('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[objPtr++] = offset();
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  write(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  for (const p of pages) {
    const pageObj = objPtr++;
    const contObj = objPtr++;
    const [r, g, b] = p.rgb;
    const margin = Math.min(p.w, p.h) * 0.1;
    const content = `q ${r} ${g} ${b} rg ${margin} ${margin} ${p.w - 2 * margin} ${p.h - 2 * margin} re f Q`;
    const contentBytes = enc.encode(content);

    offsets[pageObj] = offset();
    write(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Contents ${contObj} 0 R /Resources << >> >>\nendobj\n`,
    );

    offsets[contObj] = offset();
    write(`${contObj} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    chunks.push(contentBytes);
    len += contentBytes.length;
    write('\nendstream\nendobj\n');
  }

  const xpos = offset();
  write(`xref\n0 ${objPtr}\n0000000000 65535 f \r\n`);
  for (let i = 1; i < objPtr; i++) {
    write(`${offsets[i]!.toString().padStart(10, '0')} 00000 n \r\n`);
  }
  write(`trailer\n<< /Size ${objPtr} /Root 1 0 R >>\nstartxref\n${xpos}\n%%EOF`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
