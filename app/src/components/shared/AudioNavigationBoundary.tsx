"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { stopCurrentlyPlaying } from "./singleAudioPlayback";

function stopPageAudio() {
  window.dispatchEvent(new Event("lesson-navigation"));
  stopCurrentlyPlaying();
  // Native lesson <audio> players are not detached Audio objects, but must
  // obey the same route-change rule.
  document.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => media.pause());
}

/** Stop at navigation intent, not only after Next has finished loading a route. */
export function AudioNavigationBoundary() {
  const pathname = usePathname();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.hasAttribute("download")) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin === window.location.origin && (next.pathname !== window.location.pathname || next.search !== window.location.search)) stopPageAudio();
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", stopPageAudio);
    window.addEventListener("pagehide", stopPageAudio);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", stopPageAudio);
      window.removeEventListener("pagehide", stopPageAudio);
      stopPageAudio();
    };
  }, [pathname]);
  return null;
}
