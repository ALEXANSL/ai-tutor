/**
 * Generated test fixtures (no real books, no personal data): tiny PDFs and
 * EPUBs built in memory for the ingest tests.
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { strToU8, zipSync } from "fflate";

/** Text PDF: one string per page (Latin only — standard PDF fonts have no Cyrillic). */
export async function makeTextPdf(pages: string[], title = "Test book"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    text.split("\n").forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 16, size: 11, font }));
  }
  return doc.save();
}

/** "Scan": pages with only a drawn rectangle (no text layer). */
export async function makeScanPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([595, 842]).drawRectangle({ x: 40, y: 40, width: 500, height: 700, borderWidth: 2 });
  }
  return doc.save();
}

/**
 * A "mixed" PDF (D-54): some pages have a real text layer, others are
 * scans (a drawn rectangle, no text) — e.g. a textbook where a few pages
 * were photographed instead of typeset.
 */
export async function makeMixedPdf(pages: ({ text: string } | { scan: true })[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of pages) {
    const page = doc.addPage([595, 842]);
    if ("scan" in p) {
      page.drawRectangle({ x: 40, y: 40, width: 500, height: 700, borderWidth: 2 });
    } else {
      p.text.split("\n").forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 16, size: 11, font }));
    }
  }
  return doc.save();
}

export interface EpubChapter {
  title: string;
  html: string;
}

/** Minimal EPUB 3 with a nav document. */
export function makeEpub(title: string, chapters: EpubChapter[], opts: { nav?: boolean } = {}): Uint8Array {
  const withNav = opts.nav ?? true;
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
  };
  const items = chapters
    .map((_, i) => `<item id="c${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("");
  files["OEBPS/content.opf"] = strToU8(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></metadata><manifest>${
      withNav ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : ""
    }${items}</manifest><spine>${spine}</spine></package>`,
  );
  if (withNav) {
    files["OEBPS/nav.xhtml"] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol>${chapters
        .map((c, i) => `<li><a href="text/ch${i + 1}.xhtml#top">${c.title}</a></li>`)
        .join("")}</ol></nav></body></html>`,
    );
  }
  chapters.forEach((c, i) => {
    files[`OEBPS/text/ch${i + 1}.xhtml`] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${c.title}</title><style>p{}</style></head><body>${c.html}</body></html>`,
    );
  });
  return zipSync(files);
}
