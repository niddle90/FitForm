/**
 * jpegsToPdf — wrap one or more JPEG images into a single PDF.
 * Browser port of xbind.c.
 *
 * Unaffected by every revision of this migration (migration_v1.md §3.4,
 * migration_v2.md §3.4, migration_v3.md §2.4): JPEG marker parsing and PDF
 * object generation are both exact integer/text operations with no lossy
 * or platform-codec-dependent step anywhere in the path, so there is
 * nothing for a JS engine to diverge on. Ships zero dependencies, same as
 * the C original shipped zero *library* dependencies beyond libc.
 *
 * `pdf-lib`'s `embedJpg()` remains a documented, non-required alternative
 * (migration_v2.md §2.3) if a friendlier API is ever wanted; this file is
 * the fully-hand-rolled path.
 */

import { VaultError } from './errors.js';

const TOOL = 'jpegsToPdf';

export interface JpegMeta {
  w: number;
  h: number;
  orient: number;
  cs: 'DeviceGray' | 'DeviceCMYK' | 'DeviceRGB';
}

function r16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!;
}

function r16(b: Uint8Array, i: number, intel: boolean): number {
  return intel ? (b[i + 1]! << 8) | b[i]! : (b[i]! << 8) | b[i + 1]!;
}

/**
 * Parses JPEG markers to extract width, height, colorspace, and EXIF
 * orientation. Direct port of jpeg_meta() in xbind.c — same marker walk,
 * same 200-entry IFD-scan cap, same stop-at-SOS behaviour.
 */
export function parseJpegMeta(data: Uint8Array): JpegMeta | null {
  const m: JpegMeta = { w: 0, h: 0, orient: 1, cs: 'DeviceRGB' };

  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xd8) return null;

  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) break;

    const marker = data[pos + 1]!;
    const segLen = r16be(data, pos + 2);
    if (segLen < 2) break;

    const segData = pos + 4;
    const segEnd = pos + 2 + segLen;
    if (segEnd > data.length) break;

    // APP1 — EXIF orientation
    if (marker === 0xe1 && segLen >= 14) {
      const ap = data.subarray(segData, segEnd);
      const apLen = segLen - 2;
      if (
        apLen >= 14 &&
        ap[0] === 0x45 && // 'E'
        ap[1] === 0x78 && // 'x'
        ap[2] === 0x69 && // 'i'
        ap[3] === 0x66 && // 'f'
        ap[4] === 0x00 &&
        ap[5] === 0x00
      ) {
        const intel = ap[6] === 0x49; // 'I'
        // JS's `<<` operates on signed 32-bit ints, so a high top byte
        // (>= 0x80) would otherwise turn a legitimate large-but-valid IFD
        // offset negative -- unlike the C original's presumed unsigned
        // arithmetic. `>>> 0` reinterprets the bit pattern as unsigned.
        const ifdOff =
          (intel
            ? (ap[13]! << 24) | (ap[12]! << 16) | (ap[11]! << 8) | ap[10]!
            : (ap[10]! << 24) | (ap[11]! << 16) | (ap[12]! << 8) | ap[13]!) >>> 0;

        for (let e = 0; e < 200; e++) {
          const base = 6 + ifdOff + 2 + e * 12;
          if (base + 12 > apLen) break;
          if (r16(ap, base, intel) === 0x0112) {
            m.orient = r16(ap, base + 8, intel);
            break;
          }
        }
      }
    }
    // SOF — image dimensions and colorspace
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segData + 6 <= data.length) {
        m.h = r16be(data, segData + 1);
        m.w = r16be(data, segData + 3);
        const comp = data[segData + 5]!;
        m.cs = comp === 1 ? 'DeviceGray' : comp === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      }
    }

    if (marker === 0xda) break; // SOS: scan data begins
    pos = segEnd;
  }

  return m.w > 0 && m.h > 0 ? m : null;
}

/** Appends text/bytes while tracking the running byte offset, like ftell(out) in xbind.c. */
class PdfWriter {
  private chunks: Uint8Array[] = [];
  private len = 0;
  private encoder = new TextEncoder();

  get offset(): number {
    return this.len;
  }

  text(s: string): void {
    this.bytes(this.encoder.encode(s));
  }

  bytes(b: Uint8Array): void {
    this.chunks.push(b);
    this.len += b.length;
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function padOffset(n: number): string {
  return n.toString().padStart(10, '0');
}

/** Direct port of pdf_write() in xbind.c. */
function writePdf(images: { data: Uint8Array; meta: JpegMeta }[]): Uint8Array {
  const out = new PdfWriter();
  const offsets: number[] = [0]; // object 0 is the free-list head, unused otherwise
  let objPtr = 1;

  out.text('%PDF-1.4\n%');
  out.bytes(new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]));
  out.text('\n');

  // Object 1 — catalog
  offsets[objPtr++] = out.offset;
  out.text('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Object 2 — pages
  offsets[objPtr++] = out.offset;
  out.text('2 0 obj\n<< /Type /Pages /Kids [');
  for (let i = 0; i < images.length; i++) {
    out.text(`${3 + i * 3} 0 R `);
  }
  out.text(`] /Count ${images.length} >>\nendobj\n`);

  for (let i = 0; i < images.length; i++) {
    const { data, meta: m } = images[i]!;
    let pw = m.w;
    let ph = m.h;
    let matrix: string;

    switch (m.orient) {
      case 3: // 180°
        matrix = `-${m.w} 0 0 -${m.h} ${m.w} ${m.h}`;
        break;
      case 6: // 90° CW
        matrix = `0 ${m.w} -${m.h} 0 ${m.h} 0`;
        pw = m.h;
        ph = m.w;
        break;
      case 8: // 90° CCW
        matrix = `0 -${m.w} ${m.h} 0 0 ${m.w}`;
        pw = m.h;
        ph = m.w;
        break;
      default: // normal
        matrix = `${m.w} 0 0 ${m.h} 0 0`;
        break;
    }

    const pageObj = objPtr++;
    const contObj = objPtr++;
    const xobjObj = objPtr++;

    // Page
    offsets[pageObj] = out.offset;
    out.text(
      `${pageObj} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R` +
        ` /MediaBox [0 0 ${pw} ${ph}]` +
        ` /Contents ${contObj} 0 R` +
        ` /Resources << /XObject << /Img${i} ${xobjObj} 0 R >> >> >>\n` +
        `endobj\n`,
    );

    // Content stream
    offsets[contObj] = out.offset;
    const streamCmd = `q ${matrix} cm /Img${i} Do Q\n`;
    const slen = new TextEncoder().encode(streamCmd).length;
    out.text(`${contObj} 0 obj\n<< /Length ${slen} >>\nstream\n${streamCmd}endstream\nendobj\n`);

    // Image XObject
    offsets[xobjObj] = out.offset;
    out.text(
      `${xobjObj} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image` +
        ` /Width ${m.w} /Height ${m.h}` +
        ` /ColorSpace /${m.cs}` +
        ` /BitsPerComponent 8` +
        ` /Filter /DCTDecode` +
        ` /Length ${data.length} >>\n` +
        `stream\n`,
    );
    out.bytes(data);
    out.text('\nendstream\nendobj\n');
  }

  // Cross-reference table
  const xpos = out.offset;
  out.text(`xref\n0 ${objPtr}\n0000000000 65535 f \r\n`);
  for (let i = 1; i < objPtr; i++) {
    out.text(`${padOffset(offsets[i]!)} 00000 n \r\n`);
  }

  out.text(`trailer\n<< /Size ${objPtr} /Root 1 0 R >>\nstartxref\n${xpos}\n%%EOF`);

  return out.toUint8Array();
}

export interface JpegsToPdfResult {
  pdf: Uint8Array;
}

/**
 * Wraps one or more raw JPEG byte buffers into a single PDF, one page per
 * image, honoring EXIF orientation exactly as xbind.c does.
 */
export function jpegsToPdf(images: Uint8Array[]): JpegsToPdfResult {
  if (images.length === 0) {
    throw new VaultError(TOOL, 'ARGS', 'at least one jpeg image is required');
  }

  const parsed: { data: Uint8Array; meta: JpegMeta }[] = [];
  for (let i = 0; i < images.length; i++) {
    const data = images[i]!;
    const meta = parseJpegMeta(data);
    if (!meta) {
      throw new VaultError(TOOL, 'FORMAT', `image at index ${i} is not a valid jpeg`);
    }
    parsed.push({ data, meta });
  }

  return { pdf: writePdf(parsed) };
}
