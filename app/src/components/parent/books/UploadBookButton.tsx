"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uk } from "@/i18n/uk";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

type UploadErrorCode = "too_large" | "unsupported_type" | "not_configured" | "failed";

/**
 * "Завантажити файл" (ADR-024, US-2.7 КП-5): sends the raw file straight as
 * the request body (no multipart/FormData) so the browser streams it from
 * disk instead of loading it into JS memory first, matching the server's
 * own streaming upload. Practical limit ≈ 50 MB — checked client-side first
 * for instant feedback, and always enforced again on the server.
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
      const res = await fetch("/api/parent/books/upload", {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: UploadErrorCode } | null;
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
