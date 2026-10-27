"use client";
import Link from "next/link";
import { stopCurrentlyPlaying } from "./singleAudioPlayback";
import { useHomeNavigation } from "./HomeNavigation";

/** One-click route to the child's dashboard, also usable inside dialogs. */
export function HomeLink({ iconOnly = false }: { iconOnly?: boolean }) {
  const action = useHomeNavigation();
  return <Link href="/today" onClick={event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    window.dispatchEvent(new Event("lesson-navigation"));
    stopCurrentlyPlaying();
    document.querySelectorAll<HTMLMediaElement>("audio,video").forEach(media => media.pause());
    if (action?.run()) event.preventDefault();
  }} aria-label="На головну" title="На головну" className="app-home-link">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></svg>
    <span className={iconOnly ? "sr-only" : undefined}>На головну</span>
  </Link>;
}
