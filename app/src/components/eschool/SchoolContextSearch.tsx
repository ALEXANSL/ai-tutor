"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { resolveSchoolContextAction } from "@/app/actions/eschool";
type SearchStatus = { state: "pending" | "done" | "failed"; reason: string };
export function SchoolContextSearch({ entryId, subjectId, initial }: { entryId: string; subjectId: string; initial?: SearchStatus | null }) {
  const { refresh } = useRouter();
  const [result, setResult] = useState<SearchStatus | null>(initial ?? null);
  useEffect(() => {
    if (initial && initial.state !== "pending") return;
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    async function search(attempt = 0) {
      try {
        const response = await resolveSchoolContextAction({ entryId, subjectId });
        if (stopped) return;
        if (response.status === "error") { setResult({ state: "failed", reason: response.message }); return; }
        if (response.topicId || response.matches?.length) { refresh(); return; }
        setResult(response);
        if (response.state === "pending") {
          if (attempt < 8) timer = setTimeout(() => { void search(attempt + 1); }, 8000);
          else setResult({ state: "failed", reason: "Пошук триває довше, ніж очікувалося. Онови сторінку пізніше або обери урок зі списку." });
        }
      } catch { if (!stopped) setResult({ state: "failed", reason: "Не вдалося завершити ШІ-пошук. Можна обрати урок зі списку нижче." }); }
    }
    void search();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [entryId, subjectId, initial, refresh]);
  const pending = !result || result.state === "pending";
  return <div role="status" aria-live="polite" className="mt-3 rounded-xl border border-line bg-surface-alt p-3 text-sm">{pending ? <p className="flex items-center gap-2"><span aria-hidden="true" className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent motion-reduce:animate-none" />ШІ порівнює тему й завдання зі змістом готових уроків та підручником…</p> : <><p>{result.reason}</p><p className="mt-1 text-muted">Обери потрібний урок нижче. Тато також може зберегти точну прив’язку в щоденнику.</p></>}</div>;
}
