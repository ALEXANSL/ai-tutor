import { strFromU8, unzipSync } from "fflate";
import { uk } from "@/i18n/uk";
import { normalizeText, type Extraction, type ExtractedUnit } from "./text";

/**
 * EPUB text extraction (ADR-008): spine documents in reading order; "page" =
 * chapter number and the chapter title is the locator shown to the user.
 * Dependency-free XML handling (regex) — EPUB XHTML is well-formed enough.
 */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|blockquote|pre|dd|dt|figcaption)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return normalizeText(decodeEntities(text));
}

function firstHeading(html: string): string | null {
  const m = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i) ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m ? normalizeText(decodeEntities(m[1]!.replace(/<[^>]+>/g, " "))) : "";
  return t || null;
}

function attr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1] ?? null;
}

function resolvePath(base: string, href: string): string {
  const parts = (base ? `${base}/${href}` : href).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.map((p) => decodeURIComponent(p)).join("/");
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubError";
  }
}

export async function extractEpub(bytes: Uint8Array): Promise<Extraction> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new EpubError("not a valid EPUB (zip) file");
  }
  const read = (path: string) => (files[path] ? strFromU8(files[path]!) : null);

  const container = read("META-INF/container.xml");
  const opfPath = container ? attr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? "", "full-path") : null;
  const opf = opfPath ? read(opfPath) : null;
  if (!opfPath || !opf) throw new EpubError("EPUB package document not found");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (id && href) {
      manifest.set(id, { href: resolvePath(opfDir, href), type: attr(tag, "media-type") ?? "", props: attr(tag, "properties") ?? "" });
    }
  }
  const spine = (opf.match(/<itemref\b[^>]*>/gi) ?? [])
    .filter((t) => attr(t, "linear") !== "no")
    .map((t) => manifest.get(attr(t, "idref") ?? ""))
    .filter((m): m is { href: string; type: string; props: string } => !!m);

  const titleRaw = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1];
  const title = titleRaw ? normalizeText(decodeEntities(titleRaw)) || null : null;

  // Table of contents: EPUB 3 nav document, else EPUB 2 NCX.
  const tocByFile = new Map<string, string>();
  const toc: string[] = [];
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  const ncx = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
  const navDoc = nav ? read(nav.href) : null;
  if (navDoc && nav) {
    const navDir = nav.href.includes("/") ? nav.href.slice(0, nav.href.lastIndexOf("/")) : "";
    for (const a of navDoc.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
      const href = attr(a, "href");
      const label = normalizeText(decodeEntities(a.replace(/<[^>]+>/g, " ")));
      if (!href || !label) continue;
      toc.push(label);
      const file = resolvePath(navDir, href.split("#")[0]!);
      if (!tocByFile.has(file)) tocByFile.set(file, label);
    }
  } else if (ncx) {
    const ncxDoc = read(ncx.href) ?? "";
    const ncxDir = ncx.href.includes("/") ? ncx.href.slice(0, ncx.href.lastIndexOf("/")) : "";
    for (const np of ncxDoc.match(/<navPoint\b[\s\S]*?<content\b[^>]*>/gi) ?? []) {
      const label = normalizeText(decodeEntities(np.match(/<text>([\s\S]*?)<\/text>/i)?.[1] ?? ""));
      const src = attr(np.match(/<content\b[^>]*>/i)?.[0] ?? "", "src");
      if (!label || !src) continue;
      toc.push(label);
      const file = resolvePath(ncxDir, src.split("#")[0]!);
      if (!tocByFile.has(file)) tocByFile.set(file, label);
    }
  }

  const units: ExtractedUnit[] = [];
  for (const item of spine) {
    if (item.props.split(/\s+/).includes("nav")) continue;
    const html = read(item.href);
    if (!html) continue;
    const text = htmlToText(html);
    if (!text) continue;
    const chapter = units.length + 1;
    units.push({ page: chapter, locator: tocByFile.get(item.href) ?? firstHeading(html) ?? uk.parent.books.chapterFallback(chapter), text });
  }
  return {
    format: "epub",
    units,
    pageCount: units.length,
    charCount: units.reduce((n, u) => n + u.text.length, 0),
    title,
    toc,
  };
}
