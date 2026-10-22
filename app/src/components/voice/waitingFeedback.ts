"use client";

function playSoftTone(audioContext: AudioContext): () => void {
  try {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.value = 520;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.035, now + 0.025);
    gain.gain.linearRampToValueAtTime(0, now + 0.2);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    let ended = false;
    const disconnect = () => { ended = true; oscillator.disconnect(); gain.disconnect(); };
    oscillator.onended = disconnect;
    oscillator.start(now);
    oscillator.stop(now + 0.22);
    return () => {
      if (ended) return;
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already ended. */ }
      disconnect();
    };
  } catch { return () => {}; /* Visible feedback still works without an output device. */ }
}

/** A small device-local acknowledgement, never a generated answer. No child
 * text is sent to speech synthesis and no network/API call is made here. */
export function playWaitingFeedback(audioContext: AudioContext, text: string): () => void {
  const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  try {
    const voice = synthesis?.getVoices().find(candidate => /^uk(?:-|$)/i.test(candidate.lang) && candidate.localService);
    if (voice && typeof SpeechSynthesisUtterance !== "undefined") {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "uk-UA";
      utterance.voice = voice;
      utterance.rate = 1;
      let owned = true;
      let cancelled = false;
      let stopFallback: (() => void) | undefined;
      utterance.onend = () => { owned = false; };
      utterance.onerror = () => {
        // Browser voices can fail asynchronously (including autoplay). A stale
        // error after cancellation must never make a new tone start.
        if (!owned || cancelled) return;
        owned = false;
        stopFallback = playSoftTone(audioContext);
      };
      try { synthesis!.speak(utterance); }
      catch {
        owned = false;
        cancelled = true;
        utterance.onend = utterance.onerror = null;
        stopFallback?.();
        return playSoftTone(audioContext);
      }
      return () => {
        cancelled = true;
        utterance.onend = utterance.onerror = null;
        if (owned) { owned = false; synthesis!.cancel(); }
        stopFallback?.();
      };
    }
  } catch { /* A missing/offline device voice falls back to a soft tone. */ }
  return playSoftTone(audioContext);
}
