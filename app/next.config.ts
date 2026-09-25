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
  // Native argon2 binding must stay a server-side external module.
  serverExternalPackages: ["@node-rs/argon2"],
  // Prompt files are read at runtime on the server (Alex edits them as text).
  outputFileTracingIncludes: { "/**": ["./prompts/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withSerwist(nextConfig);
