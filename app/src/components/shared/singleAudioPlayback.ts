"use client";

/**
 * PO complaint 2026-10-07 (math-v2), recurred 2026-10-08 (literature-v2):
 * "можна одночасно слухати декілька потоків... це мало бути на рівні
 * платформи пофікшено, а не тільки для математики" — this singleton used
 * to be copy-pasted as a module-level variable inside EACH course viewer
 * (`MathCourseV2LessonView.tsx`, then `LiteratureV2LessonView.tsx`), so
 * each lesson type coordinated its OWN narration/explanation buttons but
 * had no way to know about another lesson type's audio at all. One shared
 * module, used by every course viewer (current and future), fixes that
 * for good instead of needing the same fix copied into each new subject's
 * importer slice.
 *
 * Still scoped to ONE browser tab (a `let` in a client module instance) —
 * genuinely separate tabs/windows are isolated JS realms with no shared
 * state without a cross-tab channel (BroadcastChannel, a Service Worker),
 * which is a different, much rarer problem (a child using two tabs/
 * windows open side by side) not worth the complexity here.
 */

let currentlyPlayingAudio: HTMLAudioElement | null = null;
let onCurrentlyPlayingStopped: (() => void) | null = null;

export function stopCurrentlyPlaying(): void {
  currentlyPlayingAudio?.pause();
  currentlyPlayingAudio = null;
  onCurrentlyPlayingStopped?.();
  onCurrentlyPlayingStopped = null;
}

export function isCurrentlyPlaying(audio: HTMLAudioElement | null): boolean {
  return audio !== null && currentlyPlayingAudio === audio;
}

/**
 * Stops whatever else is playing, then plays `audio` as the new "currently
 * playing" one. `onStopped` fires whenever this specific audio stops being
 * the active one (naturally ending, or a later call here stopping it) —
 * callers use it to reset their own button back to an idle state.
 */
export function playSingleAudio(audio: HTMLAudioElement, onStopped: () => void): void {
  stopCurrentlyPlaying();
  currentlyPlayingAudio = audio;
  onCurrentlyPlayingStopped = onStopped;
  const clearIfSelf = () => {
    if (currentlyPlayingAudio === audio) {
      currentlyPlayingAudio = null;
      onCurrentlyPlayingStopped = null;
    }
  };
  audio.addEventListener("ended", clearIfSelf, { once: true });
  void audio.play().catch(() => {
    clearIfSelf();
    onStopped();
  });
}
