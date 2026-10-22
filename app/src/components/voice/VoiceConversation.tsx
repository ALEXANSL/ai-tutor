"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";
import { uk } from "@/i18n/uk";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";
import { playWaitingFeedback } from "./waitingFeedback";

type Phase = "idle" | "connecting" | "listening" | "recording" | "thinking" | "speaking" | "muted";
interface VoiceLease { id: string; expiresAt: string }
interface WaitingState { acknowledgement: ReturnType<typeof setTimeout>; tick: ReturnType<typeof setInterval>; stopSound?: () => void }
interface Props {
  target: VoiceTarget;
  onTurn: (turn: VoiceTurn) => void;
  onActiveChange?: (active: boolean) => void;
}

/** A new target always owns a new microphone lifecycle, even without a caller-supplied key. */
export function VoiceConversation(props: Props) {
  return <VoiceSession key={JSON.stringify(props.target)} {...props} />;
}

function VoiceSession({ target, onTurn, onActiveChange }: Props) {
  const t = uk.child.voice;
  const owner = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState("");
  const [ending, setEnding] = useState(false);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [waitingSound, setWaitingSound] = useState(true);
  const waitingSoundEnabled = useRef(true);
  const [isMuted, setIsMuted] = useState(false);
  const muted = useRef(false);
  const needsResume = useRef(false);
  const callbacks = useRef({ onTurn, onActiveChange });
  useEffect(() => { callbacks.current = { onTurn, onActiveChange }; }, [onTurn, onActiveChange]);
  const mounted = useRef(true);
  const active = useRef(false);
  const generation = useRef(0);
  const safetyEnding = useRef(false);
  const session = useRef<VoiceLease | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const requests = useRef(new Set<{ controller: AbortController; timeout: ReturnType<typeof setTimeout> }>());
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const detector = useRef<ReturnType<typeof setInterval> | null>(null);
  const listening = useRef<(() => void) | null>(null);
  const waiting = useRef<WaitingState | null>(null);

  const endWaiting = useCallback((expected?: WaitingState) => {
    if (expected && waiting.current !== expected) return;
    const pending = waiting.current;
    waiting.current = null;
    if (pending) {
      clearTimeout(pending.acknowledgement);
      clearInterval(pending.tick);
      pending.stopSound?.();
    }
    if (mounted.current) setWaitSeconds(0);
  }, []);

  const stop = useCallback((message = "") => {
    const wasActive = active.current;
    endWaiting();
    generation.current += 1;
    active.current = false;
    safetyEnding.current = false;
    listening.current = null;
    muted.current = false;
    needsResume.current = false;
    requests.current.forEach(({ controller, timeout }) => { clearTimeout(timeout); controller.abort(); });
    requests.current.clear();
    if (detector.current !== null) clearInterval(detector.current);
    if (heartbeat.current !== null) clearInterval(heartbeat.current);
    detector.current = null;
    heartbeat.current = null;
    const recording = recorder.current;
    recorder.current = null;
    if (recording) {
      recording.onstop = null;
      recording.ondataavailable = null;
      recording.onerror = null;
      try { if (recording.state !== "inactive") recording.stop(); } catch { /* Already stopped by the browser. */ }
    }
    const playback = source.current;
    source.current = null;
    if (playback) {
      playback.onended = null;
      try { playback.stop(); } catch { /* Already ended. */ }
    }
    const mic = stream.current;
    stream.current = null;
    mic?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    const audioContext = context.current;
    context.current = null;
    if (audioContext) void audioContext.close().catch(() => {});
    const old = session.current;
    session.current = null;
    if (old) void fetch("/api/voice/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: old.id, action: "stop" }), keepalive: true,
    }).catch(() => {});
    if (wasActive) callbacks.current.onActiveChange?.(false);
    if (mounted.current) { setPhase("idle"); setEnding(false); setNotice(message); setIsMuted(false); }
  }, [endWaiting]);

  useEffect(() => {
    mounted.current = true;
    const background = () => { if (active.current) stop(t.backgroundStop); };
    const visibility = () => { if (document.visibilityState === "hidden") background(); };
    const otherAudio = () => { if (active.current) stop(t.otherAudio); };
    const otherVoice = (event: Event) => { if ((event as CustomEvent).detail !== owner) otherAudio(); };
    window.addEventListener("pagehide", background);
    window.addEventListener("lesson-navigation", background);
    window.addEventListener("lesson-voice-start", otherVoice);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("play", otherAudio, true);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", background);
      window.removeEventListener("lesson-navigation", background);
      window.removeEventListener("lesson-voice-start", otherVoice);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("play", otherAudio, true);
      stop();
    };
  }, [stop, t.backgroundStop, t.otherAudio, owner]);

  async function jsonRequest<T>(url: string, body: BodyInit, json: boolean, timeoutMs = 35_000): Promise<T> {
    const controller = new AbortController();
    const item = { controller, timeout: setTimeout(() => controller.abort(), timeoutMs) };
    requests.current.add(item);
    try {
      const response = await fetch(url, {
        method: "POST", headers: json ? { "content-type": "application/json" } : undefined,
        body, signal: controller.signal,
      });
      const data: unknown = await response.json().catch(() => { throw new Error(t.unavailable); });
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(t.unavailable);
      const problem = data as { error?: unknown; message?: unknown };
      if (!response.ok || problem.error) throw new Error(typeof problem.message === "string" ? problem.message : t.unavailable);
      return data as T;
    } finally {
      clearTimeout(item.timeout);
      requests.current.delete(item);
    }
  }

  async function leaseRequest(body: Record<string, unknown>): Promise<VoiceLease> {
    const lease = await jsonRequest<VoiceLease>("/api/voice/session", JSON.stringify(body), true);
    if (typeof lease.id !== "string" || !lease.id || !Number.isFinite(Date.parse(lease.expiresAt))) throw new Error(t.unavailable);
    return lease;
  }

  async function start() {
    if (active.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") {
      setNotice(t.unsupported);
      return;
    }
    const token = ++generation.current;
    active.current = true;
    callbacks.current.onActiveChange?.(true);
    safetyEnding.current = false;
    setEnding(false);
    setNotice("");
    setPhase("connecting");
    const valid = () => mounted.current && active.current && generation.current === token;
    try {
      window.dispatchEvent(new CustomEvent("lesson-voice-start", { detail: owner }));
      stopCurrentlyPlaying();
      document.querySelectorAll("audio").forEach((audio) => audio.pause());
      // Unlock output in the tap handler before asynchronous network work (mobile autoplay).
      const audioContext = new AudioContext();
      context.current = audioContext;
      await audioContext.resume();
      if (!valid()) return;
      const lease = await leaseRequest({ target });
      if (!valid()) {
        // Fetch can finish after stop even if its AbortSignal was ignored.
        void fetch("/api/voice/session", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: lease.id, action: "stop" }), keepalive: true,
        }).catch(() => {});
        return;
      }
      session.current = lease;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
      if (!valid()) { mic.getTracks().forEach((track) => track.stop()); return; }
      stream.current = mic;
      mic.getTracks().forEach((track) => { track.onended = () => { if (valid()) stop(t.connectionLost); }; });
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(mic).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error(t.recordingUnsupported);
      heartbeat.current = setInterval(() => {
        if (!valid() || !session.current) return;
        void leaseRequest({ id: session.current.id, action: "renew" })
          .then((next) => { if (valid()) session.current = next; })
          .catch((error) => { if (valid()) stop(error instanceof Error ? error.message : t.unavailable); });
      }, 25_000);
      let idleSince = Date.now();

      const listen = () => {
        if (!valid() || safetyEnding.current) return;
        // A mute toggled during "thinking"/"speaking" must not start a new
        // recording once that turn ends — wait here, `toggleMute` resumes by
        // calling `listening.current?.()` once the child unmutes (same path
        // `interrupt()` already used to resume a listening cycle).
        if (muted.current) { needsResume.current = true; setPhase("muted"); return; }
        needsResume.current = false;
        try {
          setPhase("listening");
          const recording = new MediaRecorder(mic, { mimeType, audioBitsPerSecond: 64_000 });
          recorder.current = recording;
          const chunks: Blob[] = [];
          const began = Date.now();
          let heard = false;
          let lastSound = began;
          let discard = false;
          let bytes = 0;
          recording.ondataavailable = (event) => {
            if (!valid()) return;
            bytes += event.data.size;
            if (bytes > 1_000_000) { stop(t.recordingTooLarge); return; }
            if (event.data.size) chunks.push(event.data);
          };
          recording.onerror = () => { if (valid()) stop(t.unavailable); };
          recording.onstop = () => {
            if (detector.current !== null) clearInterval(detector.current);
            detector.current = null;
            if (!valid()) return;
            if (discard) { listen(); return; }
            void sendTurn(new Blob(chunks, { type: mimeType }));
          };
          recording.start(1000);
          detector.current = setInterval(() => {
            if (!valid()) return;
            try {
              const now = Date.now();
              analyser.getFloatTimeDomainData(samples);
              const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
              if (rms > 0.025) {
                if (!heard) setPhase("recording");
                heard = true;
                lastSound = now;
                idleSince = now;
              }
              if (now - idleSince >= 60_000) { stop(t.silenceStop); return; }
              if ((!heard && now - began >= 2_000) || (heard && (now - lastSound > 900 || now - began >= 25_000))) {
                discard = !heard;
                if (detector.current !== null) clearInterval(detector.current);
                detector.current = null;
                if (recording.state !== "inactive") recording.stop();
              }
            } catch { if (valid()) stop(t.unavailable); }
          }, 80);
        } catch { if (valid()) stop(t.unavailable); }
      };

      const sendTurn = async (blob: Blob) => {
        if (!valid() || !session.current) return;
        endWaiting();
        setPhase("thinking");
        const beganWaiting = Date.now();
        const pending: NonNullable<typeof waiting.current> = {
          acknowledgement: setTimeout(() => {
            if (!valid() || waiting.current !== pending || !waitingSoundEnabled.current) return;
            pending.stopSound = playWaitingFeedback(audioContext, t.waitAcknowledgement);
          }, 1200),
          tick: setInterval(() => {
            if (valid() && waiting.current === pending) setWaitSeconds(Math.floor((Date.now() - beganWaiting) / 1000));
          }, 1000),
        };
        waiting.current = pending;
        const form = new FormData();
        form.set("id", session.current.id);
        form.set("audio", blob, mimeType.includes("mp4") ? "voice.mp4" : mimeType.includes("ogg") ? "voice.ogg" : "voice.webm");
        try {
          const turn = await jsonRequest<VoiceTurn | { text: "" }>("/api/voice/turn", form, false, 120_000);
          endWaiting(pending);
          if (!valid()) return;
          if (!("message" in turn)) { setNotice(t.notHeard); idleSince = Date.now(); listen(); return; }
          safetyEnding.current = turn.endReason === "safety" || (!turn.endReason && !!turn.endConversation);
          setEnding(safetyEnding.current);
          callbacks.current.onTurn(turn);
          if (!turn.audio) { stop(safetyEnding.current ? t.safetyStop : turn.endConversation ? t.sessionEnded : t.audioUnavailable); return; }
          const audioBytes = Uint8Array.from(atob(turn.audio.audioBase64), (char) => char.charCodeAt(0));
          const buffer = await audioContext.decodeAudioData(audioBytes.buffer);
          if (!valid()) return;
          const playback = audioContext.createBufferSource();
          playback.buffer = buffer;
          playback.connect(audioContext.destination);
          source.current = playback;
          setNotice("");
          setPhase("speaking");
          playback.onended = () => {
            if (!valid()) return;
            source.current = null;
            if (turn.endConversation) stop(safetyEnding.current ? t.safetyStop : t.sessionEnded);
            else { idleSince = Date.now(); listen(); }
          };
          playback.start();
        } catch (error) {
          endWaiting(pending);
          if (valid()) stop(safetyEnding.current ? t.safetyStop : error instanceof Error && error.name !== "AbortError" ? error.message : t.connectionLost);
        }
      };
      listening.current = () => { idleSince = Date.now(); listen(); };
      listen();
    } catch (error) {
      if (valid()) stop(error instanceof DOMException && error.name === "NotAllowedError" ? t.permissionDenied : error instanceof Error ? error.message : t.unavailable);
    }
  }

  function interrupt() {
    if (!active.current) return;
    // A safety override must never become a route back into another microphone turn.
    if (safetyEnding.current) { stop(t.safetyStop); return; }
    const playback = source.current;
    source.current = null;
    if (playback) { playback.onended = null; try { playback.stop(); } catch { /* Already ended. */ } }
    if (muted.current) { needsResume.current = true; setPhase("muted"); return; }
    listening.current?.();
  }

  /**
   * PO 2026-10-22: "буває потрібно відволіктись чи інші фонові шуми, навіщо
   * перевантажувати ШІ розбором контенту та пошуком відповіді, на те чого
   * його не питали" — mute pauses capture WITHOUT ending the session/lease
   * (unlike `stop()`): disables the mic track so no audio reaches the
   * analyser/recorder, and drops anything mid-recording without sending it.
   * `needsResume` remembers whether a listening cycle was paused here (as
   * opposed to muting during "thinking"/"speaking", where the in-flight
   * turn must finish normally and `listen()` itself will wait once reached).
   */
  function toggleMute() {
    if (!active.current) return;
    const next = !muted.current;
    muted.current = next;
    setIsMuted(next);
    // `getTracks()`, not `getAudioTracks()` — the stream is mic-only
    // (`getUserMedia({ audio: {...}, video: false })`), and the existing
    // `onended`/`stop()` wiring above already uses `getTracks()`.
    stream.current?.getTracks().forEach((track) => { track.enabled = !next; });
    if (next) {
      if (phase === "listening" || phase === "recording") {
        const recording = recorder.current;
        recorder.current = null;
        if (recording) {
          recording.onstop = null;
          recording.ondataavailable = null;
          recording.onerror = null;
          try { if (recording.state !== "inactive") recording.stop(); } catch { /* Already stopped by the browser. */ }
        }
        if (detector.current !== null) clearInterval(detector.current);
        detector.current = null;
        needsResume.current = true;
        setPhase("muted");
      }
    } else if (needsResume.current) {
      needsResume.current = false;
      listening.current?.();
    }
  }

  return (
    <section className="my-3 rounded-2xl border border-line bg-surface p-3.5" aria-label={t.title}>
      <p className="mb-2 text-sm font-semibold" role="status" aria-live="polite">{notice || t.phases[phase]}</p>
      {phase === "thinking" && <div className="mb-3 text-sm text-muted">
        <p aria-hidden="true">{t.waitElapsed(waitSeconds)}</p>
        {waitSeconds >= 12 && <p role="status">{t.waitSlow}</p>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {phase === "idle" ? (
          <button type="button" onClick={() => void start()} className="min-h-12 rounded-2xl bg-secondary px-4 font-bold text-white">{t.start}</button>
        ) : <>
          {phase === "speaking" && !ending && <button type="button" onClick={interrupt} className="min-h-12 rounded-2xl border-2 border-line px-4 font-bold">{t.interrupt}</button>}
          {!ending && <button type="button" onClick={toggleMute} className="min-h-12 rounded-2xl border-2 border-line px-4 font-bold">{isMuted ? t.unmute : t.mute}</button>}
          <button type="button" onClick={() => stop()} className="min-h-12 rounded-2xl border-2 border-line px-4 font-bold">{t.stop}</button>
        </>}
      </div>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={waitingSound} onChange={event => {
          waitingSoundEnabled.current = event.target.checked;
          setWaitingSound(event.target.checked);
          if (!event.target.checked) waiting.current?.stopSound?.();
        }} />
        {t.waitSound}
      </label>
      <p className="text-xs text-muted">{t.waitSoundHint}</p>
      <p className="mt-2 text-xs text-muted">{t.instructions}</p>
    </section>
  );
}
