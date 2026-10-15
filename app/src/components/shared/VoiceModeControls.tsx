"use client";

import { useEffect, useState } from "react";

/**
 * Shared voice-mode/autoplay controls (PO complaint 2026-10-15: "дизайн
 * головного інтерфейсу має бути однаковим для усіх предметів... розміщення
 * кнопок має бути стандартним і не скакати з місця на місце"). Previously
 * copy-pasted, with small drift, into `MathCourseV2LessonView.tsx`,
 * `LiteratureV2LessonView.tsx`, and `LiteratureV3LessonView.tsx` — one
 * never got "autoplay"/"voice mode" wired in at all, and the two that did
 * placed the toggles in a different order relative to the "open
 * textbook"/"open book" button. This module is the single source of truth
 * for the toggle buttons AND the persisted on/off state; every course-v2
 * lesson viewer uses it the same way, with the SAME button markup and the
 * SAME on-screen position (header, after the open-book button — see each
 * viewer's own `<header>`).
 */

function readStoredFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export interface VoiceModeControls {
  voiceMode: boolean;
  autoAdvance: boolean;
  changeVoiceMode(v: boolean): void;
  changeAutoAdvance(v: boolean): void;
}

/**
 * `storageKeyPrefix` keeps each subject's on/off choice independent
 * per-device (e.g. `"mathCourseV2"` → `localStorage` keys
 * `"mathCourseV2VoiceMode"`/`"mathCourseV2AutoAdvance"`).
 */
export function useVoiceModeControls(storageKeyPrefix: string): VoiceModeControls {
  const voiceModeKey = `${storageKeyPrefix}VoiceMode`;
  const autoAdvanceKey = `${storageKeyPrefix}AutoAdvance`;
  const [voiceMode, setVoiceMode] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);

  // Lazy-read from localStorage only after mount (avoids a server/client
  // render mismatch — `window` doesn't exist during SSR).
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setVoiceMode(readStoredFlag(voiceModeKey));
      setAutoAdvance(readStoredFlag(autoAdvanceKey));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function changeVoiceMode(v: boolean) {
    setVoiceMode(v);
    try {
      window.localStorage.setItem(voiceModeKey, v ? "1" : "0");
    } catch {
      // per-device convenience only — fine to drop silently
    }
  }

  function changeAutoAdvance(v: boolean) {
    setAutoAdvance(v);
    try {
      window.localStorage.setItem(autoAdvanceKey, v ? "1" : "0");
    } catch {
      // per-device convenience only — fine to drop silently
    }
  }

  return { voiceMode, autoAdvance, changeVoiceMode, changeAutoAdvance };
}

/** PO complaint 2026-10-07: narration needed a manual click on every screen.
 * A simple persisted (per-device, `localStorage`) toggle: while on, every
 * freshly-mounted `ListenButton` on a lesson screen/step auto-plays once. */
export function VoiceModeToggle({ voiceMode, onChange }: { voiceMode: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!voiceMode)}
      aria-pressed={voiceMode}
      className={`min-h-11 rounded-full border-2 px-3.5 text-sm font-bold ${voiceMode ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface"}`}
    >
      {voiceMode ? "🔊 Голосовий режим: увімкнено" : "🔈 Голосовий режим: вимкнено"}
    </button>
  );
}

/** PO request 2026-10-07: "режим автовідтворення" — advances past a
 * screen/step on its own once voice mode finishes narrating it. Only
 * enabled together with voice mode (nothing to wait for otherwise). */
export function AutoAdvanceToggle({ autoAdvance, voiceMode, onChange }: { autoAdvance: boolean; voiceMode: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!autoAdvance)}
      disabled={!voiceMode}
      aria-pressed={autoAdvance}
      title={voiceMode ? undefined : "Спершу увімкни голосовий режим"}
      className={`min-h-11 rounded-full border-2 px-3.5 text-sm font-bold disabled:opacity-40 ${autoAdvance && voiceMode ? "border-primary bg-primary/10 text-primary" : "border-line bg-surface"}`}
    >
      {autoAdvance ? "▶️ Автовідтворення: увімкнено" : "⏸️ Автовідтворення: вимкнено"}
    </button>
  );
}
