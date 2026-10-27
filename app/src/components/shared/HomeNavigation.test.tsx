// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import { HomeLink } from "./HomeLink";
import { HomeNavigationProvider, useHomeExit } from "./HomeNavigation";
it("uses the legacy save/pause action in one click and clears it on unmount", async () => {
  const exit = vi.fn(); const stopped = vi.fn();
  window.addEventListener("lesson-navigation", stopped);
  function Session() { useHomeExit(exit); return null; }
  const host = document.createElement("div"); const root = createRoot(host);
  await act(async () => root.render(<HomeNavigationProvider><HomeLink /><Session /></HomeNavigationProvider>));
  const link = host.querySelector('a')!;
  expect(link.getAttribute("href")).toBe("/today");
  await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
  expect(exit).toHaveBeenCalledOnce(); expect(stopped).toHaveBeenCalledOnce();
  await act(async () => root.render(<HomeNavigationProvider><HomeLink /></HomeNavigationProvider>));
  expect(host.querySelector('a')?.getAttribute("href")).toBe("/today");
  host.addEventListener("click", event => event.preventDefault(), { once: true });
  await act(async () => { host.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  expect(exit).toHaveBeenCalledOnce();
  window.removeEventListener("lesson-navigation", stopped);
  await act(async () => root.unmount());
});
