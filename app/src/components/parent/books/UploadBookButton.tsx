"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uk } from "@/i18n/uk";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

type UploadErrorCode = "too_large" | "unsupported_type" | "not_configured" | "failed";

/**
 * "Завантажити файл" (ADR-024, BUG-033): the file bytes never go through our
 * server — Vercel Serverless Functions reject any request body over ~4.5 MB
 * at the platform level, well under the app's 50 MB product limit, so
 * streaming the file to our own API route (the previous approach) could
 * never actually work. Instead:
 *   1. ask our server (JSON only, no file) to open a Google Drive resumable
 *      upload session and hand back its short-lived session URI;
 *   2. `PUT` the file straight to that URI, browser → googleapis.com
 *      directly, which is what bypasses Vercel's limit;
 *   3. tell our server (JSON only, just the resulting Drive file id) that
 *      the upload is done, so it can queue indexing as before.
 */
export function UploadBookButton({ enabled }: { enabled: boolean }) {
  const t = uk.parent.books.upload;
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ status: "idle" | "pending" | "ok" | "error"; message?: string }>({ status: "idle" });
  const router = useRouter();

  async function onFile(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setState({ status: "error", message: t.tooLarge });
      return;
    }
    setState({ status: "pending" });
    try {
      const initRes = await fetch("/api/parent/books/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size }),
      });
      if (!initRes.ok) {
        const body = (await initRes.json().catch(() => null)) as { error?: UploadErrorCode } | null;
        setState({ status: "error", message: messageFor(body?.error) });
        return;
      }
      const { sessionUrl } = (await initRes.json()) as { sessionUrl: string };

      // Direct browser → Google Drive PUT: never touches our server, so
      // Vercel's request-body limit does not apply here.
      const putRes = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) {
        setState({ status: "error", message: putRes.status === 413 ? t.tooLarge : t.failed });
        return;
      }
      const uploaded = (await putRes.json()) as { id: string };

      const completeRes = await fetch("/api/parent/books/upload/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ driveFileId: uploaded.id }),
      });
      if (!completeRes.ok) {
        const body = (await completeRes.json().catch(() => null)) as { error?: UploadErrorCode } | null;
        setState({ status: "error", message: messageFor(body?.error) });
        return;
      }
      setState({ status: "ok", message: t.done });
      router.refresh();
    } catch {
      setState({ status: "error", message: t.failed });
    }
  }

  function messageFor(code: UploadErrorCode | undefined): string {
    switch (code) {
      case "too_large":
        return t.tooLarge;
      case "unsupported_type":
        return t.unsupportedType;
      case "not_configured":
        return t.notConfigured;
      default:
        return t.failed;
    }
  }

  if (!enabled) return <p className="text-[13px] text-p-muted">{t.notConfigured}</p>;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void onFile(file);
        }}
      />
      <button
        type="button"
        disabled={state.status === "pending"}
        onClick={() => inputRef.current?.click()}
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-p-line bg-p-surface px-4 text-[14px] font-bold text-p-text disabled:opacity-60"
      >
        {state.status === "pending" ? t.uploading : `📤 ${t.button}`}
      </button>
      {state.status !== "idle" && state.message && (
        <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
          {state.message}
        </p>
      )}
    </div>
  );
}
