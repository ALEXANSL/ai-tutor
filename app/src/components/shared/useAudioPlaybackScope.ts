"use client";

import { useCallback, useEffect, useRef } from "react";
import { beginAudioPlayback, playSingleAudio, type AudioPlaybackRequest } from "./singleAudioPlayback";

/** An async audio response may only play while its component AND request own it. */
export function useAudioPlaybackScope() {
  const mounted = useRef(true);
  const current = useRef<AudioPlaybackRequest | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.cancel();
      current.current = null;
    };
  }, []);
  const isMounted = useCallback(() => mounted.current, []);
  const begin = useCallback((onStopped: () => void) => {
    const ticket = beginAudioPlayback(() => { if (mounted.current) onStopped(); });
    current.current = ticket;
    const isCurrent = () => mounted.current && ticket.isCurrent();
    return {
      isCurrent,
      cancel: ticket.cancel,
      play(audio: HTMLAudioElement, stopped: () => void, ended?: () => void) {
        if (!isCurrent()) return false;
        return playSingleAudio(audio, () => { if (mounted.current) stopped(); }, ticket,
          () => { if (mounted.current) ended?.(); });
      },
    };
  }, []);
  return { begin, isMounted };
}
