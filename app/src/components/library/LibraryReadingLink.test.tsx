// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LibraryReadingLink } from "./LibraryReadingLink";
it("shows only internal reading actions and rejects untrusted destinations", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const node = document.createElement("div"); const root = createRoot(node);
  act(() => root.render(<LibraryReadingLink link={{ href: "https://evil.example", label: "Читати" }} />)); expect(node.querySelector("a")).toBeNull();
  act(() => root.render(<LibraryReadingLink link={{ href: "/audiobooks/11111111-1111-4111-8111-111111111111", label: "Слухати книгу" }} />)); expect(node.querySelector("a")!.getAttribute("href")).toContain("/audiobooks/"); act(() => root.unmount()); vi.unstubAllGlobals();
});
