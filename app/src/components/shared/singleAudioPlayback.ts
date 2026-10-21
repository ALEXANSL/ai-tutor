"use client";

/** One active or pending narration per browser tab. Requests are invalidated
 * before playback exists, so leaving a page cannot revive late TTS audio. */
interface PlaybackOwner {
  audio: HTMLAudioElement | null;
  onStopped: () => void;
  cleanup?: () => void;
}
let current: PlaybackOwner | null = null;

export interface AudioPlaybackRequest {
  isCurrent(): boolean;
  cancel(): void;
}

function finish(owner: PlaybackOwner, pause: boolean): void {
  if (current !== owner) return;
  current = null;
  owner.cleanup?.();
  if (pause) {
    try { owner.audio?.pause(); } catch { /* The browser may have detached its media backend. */ }
  }
  owner.onStopped();
}

/** Cancels both playing audio and a request still waiting for synthesis. */
export function stopCurrentlyPlaying(): void {
  if (current) finish(current, true);
}

export function isCurrentlyPlaying(audio: HTMLAudioElement | null): boolean {
  return audio !== null && current?.audio === audio;
}

export function beginAudioPlayback(onStopped: () => void): AudioPlaybackRequest {
  stopCurrentlyPlaying();
  const owner: PlaybackOwner = { audio: null, onStopped };
  current = owner;
  return {
    isCurrent: () => current === owner,
    cancel: () => finish(owner, true),
  };
}

/** Reuse a synthesis request's ownership, or begin a fresh direct playback.
 * Natural completion alone calls onEnded; cancellation/error never advances a lesson. */
export function playSingleAudio(
  audio: HTMLAudioElement,
  onStopped: () => void,
  request?: AudioPlaybackRequest,
  onEnded?: () => void,
): boolean {
  const ticket = request ?? beginAudioPlayback(onStopped);
  if (!ticket.isCurrent() || !current) return false;
  const owner = current;
  owner.audio = audio;
  owner.onStopped = onStopped;
  const ended = () => {
    if (current !== owner) return;
    finish(owner, false);
    onEnded?.();
  };
  const failed = () => finish(owner, true);
  audio.addEventListener("ended", ended);
  audio.addEventListener("error", failed);
  owner.cleanup = () => {
    audio.removeEventListener("ended", ended);
    audio.removeEventListener("error", failed);
  };
  try {
    void audio.play().then(() => {
      // Some media backends resolve play after cancellation. Do not stop a
      // newer legitimate replay of this same element.
      if (current !== owner && current?.audio !== audio) audio.pause();
    }).catch(failed);
  } catch { failed(); }
  return current === owner;
}
