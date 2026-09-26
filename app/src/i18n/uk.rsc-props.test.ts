import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { uk } from "./uk";

/**
 * BUG-017 (Critical, every `/lesson/[sessionId]` open):
 * "Error: Functions cannot be passed directly to Client Components unless
 * you explicitly expose it by marking it with 'use server'."
 *
 * Root cause: `uk.child.lesson` (the object `sourceRef`/`stepOf` live on)
 * was passed WHOLE as a `labels` prop from the server component
 * `app/(child)/lesson/[sessionId]/page.tsx` into the client component
 * `LessonRunner` — React's Flight (RSC) serializer rejects any function
 * value crossing that server->client props boundary, whether or not the
 * page actually reads `sourceRef` itself.
 *
 * Fix: `LessonRunner` (and `FriendChatScreen`, same pattern) now import
 * `uk` directly as a client-side value import instead of receiving a
 * `labels` prop computed on the server.
 */
describe("BUG-017: uk.child.lesson contains function properties (the actual crash surface)", () => {
  it("sourceRef and stepOf are functions, not plain strings", () => {
    expect(typeof uk.child.lesson.sourceRef).toBe("function");
    expect(typeof uk.child.lesson.stepOf).toBe("function");
  });

  it("really does crash React's server->client serializer when passed as a whole prop (genuine repro, not a mock)", () => {
    // Runs in a fresh Node process under the `react-server` condition,
    // using Next.js's own bundled `react-server-dom-webpack`, so this
    // exercises the exact serializer Next.js uses in production — not a
    // stand-in for it. It builds a plain object shaped like the real
    // `uk.child.lesson` (same two offending function keys) since the
    // child process can't import project TypeScript directly, and feeds
    // it to a fake client-component reference exactly as `page.tsx` used
        // to feed `t = uk.child.lesson` to `<LessonRunner labels={t} />`.
    const script = `
      const React = require("react");
      const RSDW = require("next/dist/compiled/react-server-dom-webpack/server.node.js");

      function ClientComp() { return null; }
      ClientComp.$$typeof = Symbol.for("react.client.reference");
      ClientComp.$$id = "test#ClientComp";
      ClientComp.$$async = false;

      // Shaped like the real uk.child.lesson: plain strings plus the two
      // function properties that actually broke production.
      const labels = {
        pickTitle: "x",
        stepOf: (k, n) => \`Крок \${k} з \${n}\`,
        sourceRef: (title, page) => (page ? \`\${title}, стор. \${page}\` : title),
      };

      const el = React.createElement(ClientComp, { labels });
      let out = "";
      const stream = RSDW.renderToPipeableStream(el, {});
      stream.pipe({
        write(chunk) { out += Buffer.from(chunk).toString("utf8"); return true; },
        end() { process.stdout.write(out); },
        on() {},
      });
    `;
    let stdout = "";
    let threw = false;
    try {
      stdout = execFileSync(process.execPath, ["--conditions", "react-server", "-e", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      // renderToPipeableStream reports the error asynchronously (an error
      // row in the Flight stream) rather than throwing synchronously, so
      // the process still exits 0 in practice; this catch is defensive.
      threw = true;
      stdout = String((e as { stdout?: Buffer }).stdout ?? "");
    }
    expect(threw || stdout.length > 0).toBe(true);
    expect(stdout).toContain("Functions cannot be passed directly to Client Components");
  });
});

/**
 * Static guard: the props boundary that actually broke (the lesson page ->
 * LessonRunner) must never again hand the whole `uk.child.lesson` namespace
 * (or any slice of it) to the client component as a prop. `LessonRunner`
 * must import `uk` itself instead, since it is already a client module.
 */
describe("BUG-017: lesson page no longer passes uk.child.lesson across the server->client boundary", () => {
  const pagePath = fileURLToPath(new URL("../app/(child)/lesson/[sessionId]/page.tsx", import.meta.url));
  const runnerPath = fileURLToPath(new URL("../components/lesson/LessonRunner.tsx", import.meta.url));
  const friendPagePath = fileURLToPath(new URL("../app/(child)/friend/page.tsx", import.meta.url));
  const friendScreenPath = fileURLToPath(new URL("../components/child/FriendChatScreen.tsx", import.meta.url));

  it("page.tsx does not import uk or pass a labels prop to LessonRunner", () => {
    const src = readFileSync(pagePath, "utf8");
    expect(src).not.toMatch(/from "@\/i18n\/uk"/);
    expect(src).not.toMatch(/labels=/);
  });

  it("LessonRunner imports uk as a value (not type-only) so it can read labels itself", () => {
    const src = readFileSync(runnerPath, "utf8");
    expect(src).toMatch(/^import \{ uk \} from "@\/i18n\/uk";/m);
    expect(src).not.toMatch(/^import type \{ uk \}/m);
    // The exported component itself no longer takes `labels` as a prop.
    expect(src).toMatch(/const t = uk\.child\.lesson;/);
  });

  it("friend page/screen follow the same fix (same bug class)", () => {
    const pageSrc = readFileSync(friendPagePath, "utf8");
    const screenSrc = readFileSync(friendScreenPath, "utf8");
    expect(pageSrc).not.toMatch(/labels=/);
    expect(screenSrc).toMatch(/^import \{ uk \} from "@\/i18n\/uk";/m);
    expect(screenSrc).toMatch(/const t = uk\.child\.friend;/);
  });
});
