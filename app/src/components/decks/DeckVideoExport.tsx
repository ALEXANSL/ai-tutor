"use client";
import { useRef, useState } from "react";
import { loadPdfDocument, renderPdfPage, type PdfPageProxyLike, type PdfRenderTaskLike } from "@/components/child/pdfEngine";
import { fitRect, pickRecorderType, totalSeconds, videoFileName } from "./deckVideo";

const WIDTH = 1280, HEIGHT = 720, PAUSE = 0.6;

/**
 * "Зберегти як відео" (ADR-049): records the narrated deck in the browser —
 * slide images from the deck PDF and its cached narration — into one video
 * file. Recording runs in real time, so it takes as long as the lesson.
 */
export function DeckVideoExport({ id, title, slides, preview = false }: { id: string; title: string; slides: number; preview?: boolean }) {
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const cancelled = useRef(false);
  const base = `/api/presentations/${id}/`, suffix = preview ? "?preview=1" : "";

  async function record() {
    const type = typeof MediaRecorder === "undefined" ? null : pickRecorderType(t => MediaRecorder.isTypeSupported(t));
    if (!type) { setState("error"); setProgress("Цей браузер не вміє записувати відео. Спробуйте Chrome або Safari."); return; }
    cancelled.current = false; setState("working"); setProgress("Готую слайди й озвучку…");
    if (file) URL.revokeObjectURL(file.url);
    setFile(null);
    const audioCtx = new AudioContext();
    try {
      const doc = await loadPdfDocument(base + suffix, base + "slides.pdf" + suffix);
      const buffers: AudioBuffer[] = [];
      for (let i = 0; i < slides; i++) {
        const res = await fetch(base + (i + 1) + ".mp3" + suffix);
        if (!res.ok) throw new Error("audio");
        buffers.push(await audioCtx.decodeAudioData(await res.arrayBuffer()));
      }
      const total = Math.ceil(totalSeconds(buffers.map(b => b.duration), PAUSE));
      const page = document.createElement("canvas");
      const out = document.createElement("canvas"); out.width = WIDTH; out.height = HEIGHT;
      const draw = out.getContext("2d")!;
      const refs = { renderTaskRef: { current: null as PdfRenderTaskLike | null }, prevPageRef: { current: null as PdfPageProxyLike | null } };
      const dest = audioCtx.createMediaStreamDestination();
      const stream = new MediaStream([...out.captureStream(10).getVideoTracks(), ...dest.stream.getAudioTracks()]);
      const recorder = new MediaRecorder(stream, { mimeType: type.mimeType, videoBitsPerSecond: 2_500_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      const finished = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
      await audioCtx.resume();
      let elapsed = 0;
      for (let i = 0; i < slides && !cancelled.current; i++) {
        await renderPdfPage({ doc, pageNum: i + 1, canvas: page, maxRenderWidth: WIDTH, refs });
        draw.fillStyle = "#000"; draw.fillRect(0, 0, WIDTH, HEIGHT);
        const r = fitRect(page.width, page.height, WIDTH, HEIGHT);
        draw.drawImage(page, r.x, r.y, r.w, r.h);
        if (i === 0) recorder.start(1000);
        setProgress(`Записую слайд ${i + 1} із ${slides}: ${Math.round(elapsed)} с із ${total} с. Не закривайте вкладку.`);
        const buffer = buffers[i]!;
        const source = audioCtx.createBufferSource();
        source.buffer = buffer; source.connect(dest);
        await new Promise<void>(resolve => { source.onended = () => resolve(); source.start(); });
        await new Promise(resolve => setTimeout(resolve, PAUSE * 1000));
        elapsed += buffer.duration + PAUSE;
      }
      if (recorder.state !== "inactive") recorder.stop();
      await finished;
      stream.getTracks().forEach(t => t.stop());
      if (cancelled.current) { setState("idle"); setProgress(""); return; }
      const blob = new Blob(chunks, { type: type.mimeType.split(";")[0] });
      setFile({ url: URL.createObjectURL(blob), name: videoFileName(title, type.extension) });
      setState("done");
      setProgress(type.extension === "mp4" ? "Відео готове." : "Відео готове у форматі WebM (цей браузер не записує MP4). Його відкривають Chrome, Firefox і VLC.");
    } catch {
      setState("error"); setProgress("Не вдалося записати відео. Перевірте, що всі слайди озвучені, і спробуйте ще раз.");
    } finally {
      void audioCtx.close();
    }
  }

  const button = "min-h-12 rounded-xl border border-current px-4";
  return <section className="space-y-2" aria-label="Відео з презентації">
    <div className="flex flex-wrap items-center gap-2">
      {state !== "working" && <button className={button} onClick={record}>Зберегти як відео MP4</button>}
      {state === "working" && <button className={button} onClick={() => { cancelled.current = true; }}>Зупинити запис</button>}
      {file && <a className="underline" href={file.url} download={file.name}>Завантажити «{file.name}»</a>}
    </div>
    {progress && <p role={state === "error" ? "alert" : "status"}>{progress}</p>}
    {state === "idle" && <p className="text-sm opacity-80">Запис триває стільки, скільки звучить урок. Файл зберігається лише на цьому пристрої.</p>}
  </section>;
}
