import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // The service worker is only built for production; dev stays uncached.
  disable: process.env.NODE_ENV === "development",
  // Do not reload automatically: the child may be in the middle of a step.
  reloadOnOnline: false,
  additionalPrecacheEntries: [{ url: "/offline", revision: "s0-1" }],
});

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Microphone/camera are enabled per-screen in later slices (S10, S13).
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native argon2 binding must stay a server-side external module. `unpdf`/`pdfjs-dist`
  // must stay external too: unpdf resolves its cMap/standard-font data files via
  // `import.meta.resolve("pdfjs-dist/package.json")` at runtime (see extract-pdf.ts) — if
  // webpack bundles it, that resolve breaks silently (caught) and PDF text extraction loses
  // CMap support for embedded CID/subset fonts, which is exactly the bug this avoids (root
  // cause: PDF ingest support ticket 2026-09-28, "AI_for_Teenagers.pdf" misflagged as a scan).
  serverExternalPackages: ["@node-rs/argon2", "unpdf", "pdfjs-dist"],
  // Prompt files are read at runtime on the server (Alex edits them as text). pdfjs-dist's
  // cmaps/standard_fonts are data files read at runtime by pdf.js (not `require`d/`import`ed),
  // so Next's file tracer would otherwise drop them from the deployed build.
  outputFileTracingIncludes: {
    "/**": ["./prompts/**/*", "./node_modules/pdfjs-dist/cmaps/**/*", "./node_modules/pdfjs-dist/standard_fonts/**/*"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withSerwist(nextConfig);
