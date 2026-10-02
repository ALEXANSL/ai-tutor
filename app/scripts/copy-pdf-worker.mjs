#!/usr/bin/env node
// PDF reader (Alex, 2026-10-02): `pdfjs-dist`'s own worker file must be
// served as a plain static asset at a fixed URL the browser can fetch
// directly — `new URL("pdfjs-dist/...", import.meta.url)` (the usual
// bundler trick) fails Next's webpack build ("ESM packages need to be
// imported"), and pointing at a CDN would mean an offline-first PWA page
// breaking without network. Copying the file into `public/` at dev/build
// time (hooked as `predev`/`prebuild` in package.json) keeps the version in
// sync with the installed `pdfjs-dist` dependency without committing a
// third-party binary to the repo.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const destDir = join(here, "..", "public");
const dest = join(destDir, "pdf.worker.min.mjs");

if (!existsSync(src)) {
  console.warn(`copy-pdf-worker: ${src} not found — is pdfjs-dist installed?`);
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copy-pdf-worker: copied to ${dest}`);
