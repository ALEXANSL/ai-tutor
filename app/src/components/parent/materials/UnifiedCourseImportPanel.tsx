"use client";

import { useEffect, useRef, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { inspectUnifiedCourseAction, importUnifiedCourseAction } from "@/app/actions/unified-course-import";
import { getBrowserSupabaseStorageClient } from "@/lib/supabase-browser";
import { withBusySignal } from "@/lib/busy-signal";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import type { SubjectOption } from "@/server/books/queries";
import { parentButton, parentInput } from "@/app/parent/ui";

type Preview = Extract<Awaited<ReturnType<typeof inspectUnifiedCourseAction>>, { status: "ready" }>["preview"];
type Summary = Extract<Awaited<ReturnType<typeof importUnifiedCourseAction>>, { status: "ok" }>["summary"];
type Phase = "idle" | "uploading" | "checking" | "ready" | "importing" | "done";

/** One prepared course ZIP goes directly to private staging. Inspection and
 * import pass only selectors to the server, never individual JSON documents. */
export function UnifiedCourseImportPanel({ subjects }: { subjects: SubjectOption[] }) {
  const [subjectId, setSubjectId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState("");
  const [canRetryImport, setCanRetryImport] = useState(true);
  const [copyNotice, setCopyNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const busy = phase === "uploading" || phase === "checking" || phase === "importing";
  function reset() {
    version.current++;
    setPhase("idle");
    setStoragePath(null);
    setPreview(null);
    setSummary(null);
    setMessage("");
    setCanRetryImport(true);
  }

  function chooseAnother() {
    reset();
    setFile(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function inspect() {
    if (lock.current) return;
    if (!subjectId) { setMessage("Спочатку оберіть предмет."); return; }
    if (!file) { setMessage("Оберіть готовий ZIP-архів курсу."); return; }
    if (!/\.zip$/i.test(file.name)) { setMessage("Потрібен один ZIP-архів курсу. Розпаковувати його не потрібно."); return; }
    if (!file.size || file.size > MAX_COURSE_ZIP_BYTES) {
      setMessage(`Архів має бути непорожнім і не більшим за ${MAX_COURSE_ZIP_BYTES / 1024 / 1024} МБ.`);
      return;
    }
    const current = version.current;
    const valid = () => mounted.current && version.current === current;
    lock.current = true;
    setMessage("");
    setPreview(null);
    setSummary(null);
    try {
      await withBusySignal(async () => {
        let path = storagePath;
        if (!path) {
          setPhase("uploading");
          const init = await fetch("/api/parent/course-import/init", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ fileName: file.name, size: file.size }),
          });
          if (!init.ok) throw new Error("Не вдалося підготувати завантаження. Спробуйте ще раз.");
          const upload = await init.json() as { path: string; token: string };
          if (!valid()) return;
          if (typeof upload.path !== "string" || typeof upload.token !== "string") throw new Error("Не вдалося підготувати завантаження. Спробуйте ще раз.");
          const client = getBrowserSupabaseStorageClient();
          if (!client) throw new Error("Завантаження тимчасово недоступне. Спробуйте пізніше.");
          const { error } = await client.storage.from("course_import_staging").uploadToSignedUrl(upload.path, upload.token, file);
          if (!valid()) return;
          if (error) throw new Error("Не вдалося передати архів. Перевірте з’єднання та спробуйте ще раз.");
          path = upload.path;
          setStoragePath(path);
        }
        if (!valid()) return;
        setPhase("checking");
        const result = await inspectUnifiedCourseAction({ subjectId, storagePath: path });
        if (!valid()) return;
        if (result.status === "ready") {
          setPreview(result.preview);
          setCanRetryImport(true);
          setPhase("ready");
        } else {
          setMessage(result.message);
          setPhase("idle");
        }
      });
    } catch (error) {
      unstable_rethrow(error);
      if (valid()) {
        setMessage(error instanceof Error ? error.message : "Не вдалося перевірити архів. Спробуйте ще раз.");
        setPhase("idle");
      }
    } finally { lock.current = false; }
  }

  async function importCourse() {
    if (lock.current || !storagePath || !preview?.canImport || !canRetryImport) return;
    const current = version.current;
    const valid = () => mounted.current && version.current === current;
    lock.current = true;
    setMessage("");
    setPhase("importing");
    try {
      await withBusySignal(async () => {
        const result = await importUnifiedCourseAction({ subjectId, storagePath, fingerprint: preview.fingerprint });
        if (!valid()) return;
        if (result.status === "ok") {
          setSummary(result.summary);
          setPhase("done");
        } else {
          setMessage(result.message);
          setCanRetryImport(result.retryable !== false);
          setPhase("ready");
        }
      });
    } catch (error) {
      unstable_rethrow(error);
      if (valid()) {
        setMessage("Не вдалося завершити імпорт. Можна повторити спробу з уже переданим архівом.");
        setPhase("ready");
      }
    } finally { lock.current = false; }
  }

  async function copyPrompt() {
    try {
      const response = await fetch("/content-package-prompt.md");
      if (!response.ok) throw new Error("prompt unavailable");
      const prompt = await response.text();
      if (!mounted.current) return;
      await navigator.clipboard.writeText(prompt);
      if (mounted.current) setCopyNotice("Промпт скопійовано. Вставте його в ChatGPT разом із підручником.");
    } catch {
      if (mounted.current) setCopyNotice("Не вдалося скопіювати. Відкрийте або завантажте промпт за посиланням поруч.");
    }
  }

  const stage = phase === "done" || phase === "importing" ? 3 : phase === "ready" || phase === "checking" ? 2 : 1;
  return <div className="space-y-5">
    <ol className="grid gap-2 text-sm sm:grid-cols-3" aria-label="Етапи завантаження курсу">
      {["Оберіть архів", "Перевірте вміст", "Додайте курс"].map((label, index) => <li key={label} aria-current={stage === index + 1 ? "step" : undefined}
        className={`rounded-xl border px-3 py-2 ${stage === index + 1 ? "border-p-primary bg-p-bg font-bold text-p-text" : "border-p-line text-p-muted"}`}>
        <span aria-hidden="true">{index + 1}. </span>{label}
      </li>)}
    </ol>

    <p className="text-sm leading-relaxed text-p-muted">Завантажте один готовий архів курсу. Застосунок сам знайде уроки, завдання та наявні ілюстрації й PDF. Якщо медіа не потрібні, їх можна не додавати.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-sm font-bold text-p-text">
        Предмет
        <select className={parentInput} value={subjectId} disabled={busy} onChange={event => { reset(); setSubjectId(event.target.value); }}>
          <option value="">Оберіть предмет</option>
          {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-bold text-p-text">
        ZIP курсу
        <input ref={fileInput} type="file" accept=".zip,application/zip" disabled={busy} className={`${parentInput} py-2 font-normal`}
          onChange={event => { reset(); setFile(event.target.files?.[0] ?? null); }} />
        <span className="text-xs font-normal text-p-muted">До {MAX_COURSE_ZIP_BYTES / 1024 / 1024} МБ. Не розпаковуйте й не розділяйте файли. Після невдалого імпорту тимчасовий архів доступний до 24 годин.</span>
      </label>
    </div>

    {phase !== "ready" && phase !== "importing" && phase !== "done" && <button type="button" className={parentButton} disabled={busy || !subjectId || !file} onClick={() => void inspect()}>
      {phase === "uploading" ? "Передаю архів…" : phase === "checking" ? "Перевіряю вміст…" : storagePath ? "Повторити перевірку" : "Перевірити архів"}
    </button>}
    {busy && <p role="status" className="text-sm text-p-muted">{phase === "uploading" ? "Архів передається. Залиште цю сторінку відкритою." : phase === "checking" ? "Перевіряю структуру й посилання на матеріали. Курс ще не змінюється." : "Додаю матеріали курсу. Не закривайте сторінку до завершення."}</p>}
    {message && <p role="alert" className="whitespace-pre-line break-words rounded-xl border border-p-danger p-3 text-sm font-semibold text-p-danger">{message}</p>}

    {preview && phase !== "done" && <section aria-label="Вміст архіву" className="space-y-4 rounded-2xl border border-p-line bg-p-bg p-4">
      <div><h3 className="font-bold text-p-text">{preview.title}</h3><p className="mt-1 text-xs text-p-muted">{preview.formatLabel}</p></div>
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[["Уроків", preview.lessons], ["Завдань", preview.tasks], ["Ілюстрацій", preview.images], ["PDF уроків", preview.pdfs]].map(([label, count]) => <div key={label} className="rounded-xl bg-p-surface p-3"><dt className="text-p-muted">{label}</dt><dd className="mt-1 text-xl font-bold text-p-text">{count}</dd></div>)}
      </dl>
      {preview.existing && <p className="text-sm leading-relaxed text-p-muted">Такий курс уже є в цьому предметі. Перевірте зауваження перед оновленням матеріалів.</p>}
      {preview.warnings.length > 0 && <Warnings title="Зверніть увагу перед завантаженням" items={preview.warnings} />}
      {!preview.canImport && <p role="alert" className="text-sm font-semibold text-p-danger">Цей пакет поки не можна завантажити. Виправте зазначені проблеми й перевірте архів знову.</p>}
      <div className="flex flex-wrap gap-3">
        {preview.canImport && canRetryImport && <button type="button" className={parentButton} disabled={busy} onClick={() => void importCourse()}>{phase === "importing" ? "Додаю курс…" : message ? "Повторити імпорт" : preview.existing ? "Оновити курс" : "Додати курс"}</button>}
        {!busy && <button type="button" className="min-h-11 rounded-xl border border-p-line px-4 text-sm font-semibold text-p-text" onClick={chooseAnother}>Перевірити інший архів</button>}
      </div>
      {!canRetryImport && <button type="button" className={parentButton} disabled={busy} onClick={() => void inspect()}>Перевірити архів ще раз</button>}
    </section>}

    {summary && phase === "done" && <section aria-label="Результат завантаження" className="space-y-2 rounded-2xl border border-p-line bg-p-bg p-4">
      <h3 role="status" className={`font-bold ${summary.warnings.length ? "text-p-text" : "text-p-success"}`}>{summary.warnings.length ? "Курс додано із зауваженнями" : "Курс додано"}</h3>
      <p className="text-sm text-p-text">{summary.title}</p>
      <p className="text-sm text-p-muted">Уроків: {summary.lessons} · завдань: {summary.tasks} · медіафайлів завантажено: {summary.assetsUploaded}</p>
      {summary.warnings.length > 0 && <Warnings title="Зауваження до результату" items={summary.warnings} />}
      <button type="button" className="min-h-11 rounded-xl border border-p-line px-4 text-sm font-semibold text-p-text" onClick={chooseAnother}>Додати ще один курс</button>
    </section>}

    <aside className="space-y-2 border-t border-p-line pt-4 text-sm">
      <h3 className="font-bold text-p-text">Підготуйте курс у ChatGPT</h3>
      <p className="leading-relaxed text-p-muted">Скористайтеся універсальним промптом разом із підручником. Результат — один ZIP для цієї форми.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="min-h-11 rounded-xl border border-p-line px-3 font-semibold text-p-text" onClick={() => void copyPrompt()}>Скопіювати промпт</button>
        <a href="/content-package-prompt.md" download className="inline-flex min-h-11 items-center font-semibold text-p-primary underline">Завантажити промпт</a>
        <a href="/content-package-prompt.md" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-p-primary underline">Відкрити</a>
      </div>
      {copyNotice && <p role="status" className="text-xs text-p-muted">{copyNotice}</p>}
    </aside>
  </div>;
}

function Warnings({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-xl border border-p-line bg-p-surface p-3 text-sm"><p className="mb-2 font-semibold text-p-text">{title}</p><ul className="max-h-72 list-disc space-y-1 overflow-y-auto pl-5 text-p-muted">{items.map((item, index) => <li key={index}>{item}</li>)}</ul></div>;
}
