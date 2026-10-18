// A small PDF writer for pages of text and rules (#592): the three standard Helvetica faces, so nothing is
// embedded and nothing is downloaded. Coordinates are points from the top left of the page.

/// Helvetica's advance widths for ' ' to '~', in thousandths of the font size.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// The characters WinAnsiEncoding places above Latin-1's control range; the rest of Latin-1 maps to itself.
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99,
};

type PdfFace = 'regular' | 'bold' | 'italic';
const PDF_FACES: Record<PdfFace, string> = { regular: 'F1', bold: 'F2', italic: 'F3' };

/// A character as the byte the page writes, or '?' where the encoding has none.
const winAnsi = (c: string) => {
  const code = c.charCodeAt(0);
  if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return c;
  return WIN_ANSI[c] ? String.fromCharCode(WIN_ANSI[c]) : '?';
};

/// How wide a run of text is set, in points. Bold is a touch wider than the regular face.
export function pdfTextWidth(text: string, size: number, face: PdfFace = 'regular') {
  let w = 0;
  for (const c of text) { const code = c.charCodeAt(0); w += code >= 32 && code <= 126 ? HELVETICA[code - 32] : 556; }
  return w * size / 1000 * (face === 'bold' ? 1.08 : 1);
}

/// Text broken into lines no wider than `width`, at most `lines` of them; what does not fit ends in an ellipsis.
export function pdfWrap(text: string, width: number, size: number, lines = 1, face: PdfFace = 'regular') {
  const out: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);
  let line = '';
  while (words.length && out.length < lines) {
    const next = line ? `${line} ${words[0]}` : words[0];
    if (pdfTextWidth(next, size, face) <= width) { line = next; words.shift(); continue; }
    if (!line) { line = words.shift()!; }
    out.push(line); line = '';
  }
  if (line && out.length < lines) out.push(line);
  else if (line) words.unshift(line);
  if (words.length && out.length) {
    let last = out[out.length - 1];
    while (last && pdfTextWidth(last + '…', size, face) > width) last = last.slice(0, -1);
    out[out.length - 1] = last.trimEnd() + '…';
  }
  // A single word wider than the cell is cut to fit.
  return out.map(l => { while (l.length > 1 && pdfTextWidth(l, size, face) > width) l = l.slice(0, -2) + '…'; return l; });
}

/// A page being drawn. Letter by default.
export function pdfPage(width = 612, height = 792) {
  const ops: string[] = [];
  const n = (v: number) => (Math.round(v * 100) / 100).toString();
  const esc = (s: string) => [...s].map(winAnsi).join('').replace(/[\\()]/g, m => '\\' + m);
  return {
    width, height, ops,
    /// Text with its baseline at y; `align` says which end of the text x is.
    text(x: number, y: number, s: string, size: number, opt: { face?: PdfFace; gray?: number; align?: 'left' | 'center' | 'right' } = {}) {
      const face = opt.face || 'regular';
      const w = pdfTextWidth(s, size, face);
      const at = opt.align === 'right' ? x - w : opt.align === 'center' ? x - w / 2 : x;
      ops.push(`${n(opt.gray ?? 0)} g BT /${PDF_FACES[face]} ${n(size)} Tf ${n(at)} ${n(height - y)} Td (${esc(s)}) Tj ET`);
    },
    rule(x1: number, y1: number, x2: number, y2: number, lineWidth = 0.5, gray = 0.6) {
      ops.push(`${n(gray)} G ${n(lineWidth)} w ${n(x1)} ${n(height - y1)} m ${n(x2)} ${n(height - y2)} l S`);
    },
    fill(x: number, y: number, w: number, h: number, gray: number) {
      ops.push(`${n(gray)} g ${n(x)} ${n(height - y - h)} ${n(w)} ${n(h)} re f`);
    },
  };
}
export type PdfPage = ReturnType<typeof pdfPage>;

/// The pages as a PDF file.
export function pdfDocument(pages: PdfPage[], title: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add('');
  const tree = add('');
  const fonts = (['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique'] as const)
    .map(f => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
  // The title is shown by the reader rather than drawn, so it is UTF-16 rather than WinAnsi.
  const utf16 = [...title].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const info = add(`<< /Title <FEFF${utf16}> /Producer (rPDU2MQTT) >>`);
  const kids = pages.map(p => {
    const stream = p.ops.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Contents ${content} 0 R `
      + `/Resources << /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R /F3 ${fonts[2]} 0 R >> >> >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  // Every character is one byte, so string offsets are byte offsets.
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
