"use client";

import { useEffect, useState } from "react";
import { useAudioPlaybackScope } from "./useAudioPlaybackScope";

type AudioResponse = { status: "ok"; audioMime: string; audioBase64: string } | { status: string };
interface Props {
  identity: string;
  text: string;
  synthesize: () => Promise<AudioResponse>;
  autoPlay?: boolean;
  onEnded?: () => void;
}

/** Identity changes reset state and cancel both active playback and pending TTS. */
export function NarrationButton(props: Props) {
  return <ScopedNarrationButton key={JSON.stringify([props.identity, !!props.autoPlay])} {...props} />;
}

function ScopedNarrationButton({ text, synthesize, autoPlay, onEnded }: Props) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "unavailable">("idle");
  const scope = useAudioPlaybackScope();

  async function play() {
    if (state === "loading") return;
    const request = scope.begin(() => setState("idle"));
    setState("loading");
    try {
      const response = await synthesize();
      if (!request.isCurrent()) return;
      if (response.status !== "ok" || !("audioMime" in response) || !("audioBase64" in response)) {
        request.cancel();
        setState("unavailable");
        return;
      }
      const audio = new Audio(`data:${response.audioMime};base64,${response.audioBase64}`);
      setState("playing");
      request.play(audio, () => setState("idle"), onEnded);
    } catch {
      if (!request.isCurrent()) return;
      request.cancel();
      setState("unavailable");
    }
  }

  useEffect(() => {
    if (!autoPlay || !text.trim()) return;
    let cancelled = false;
    Promise.resolve().then(() => { if (!cancelled) void play(); });
    return () => { cancelled = true; };
    // A fresh keyed instance owns this one narration attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!text.trim()) return null;
  return (
    <button type="button" onClick={play} disabled={state === "loading" || state === "playing"}
      className="min-h-9 rounded-full border-2 border-line bg-surface px-3 text-xs font-bold disabled:opacity-60">
      {state === "loading" ? "…" : state === "playing" ? "🔊 Грає…" : state === "unavailable" ? "🔇 Недоступно" : "🔊 Слухати"}
    </button>
  );
}
