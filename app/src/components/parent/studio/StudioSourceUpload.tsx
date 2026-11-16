"use client";
import Link from "next/link";
import { withBusySignal } from "@/lib/busy-signal";
import { useEffect, useRef, useState } from "react";
import { SOURCE_FILE_ACCEPT, SOURCE_FILE_LABEL, SOURCE_MIME, sourceFileFormat } from "@/lib/source-files";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { completeSourceUpload, openSourceUpload, putSourceUpload, SourceUploadError } from "@/lib/upload-source";
import { prepareStudioPhoto } from "@/lib/studio-photo";
import { studioSourceStatusAction, resumeStudioSourceAction } from "@/app/actions/studio-sources";
import { parentButton } from "@/app/parent/ui";

type SourceStatus = Awaited<ReturnType<typeof studioSourceStatusAction>>;
const stages: Record<string, string> = { download: "Читаємо файл", extract: "Витягуємо текст", ocr: "Розпізнаємо сторінки", embed: "Готуємо пошук", structure: "Визначаємо зміст" };
export function StudioSourceUpload({ enabled, selectedId = "", onSelect, onReady, onBusy, onTasks }: { enabled: boolean; selectedId?: string; onSelect?: (book: { id: string; title: string }) => void; onReady?: (ready: boolean) => void; onBusy?: (busy: boolean) => void; onTasks?: (text: string) => void }) {
  const [uploading, setUploading] = useState(false), [percent, setPercent] = useState(0), [phase, setPhase] = useState("");
  const [pollError, setPollError] = useState("");
  const [source, setSource] = useState<SourceStatus | null>(null), [id, setId] = useState(selectedId), [error, setError] = useState("");
  const retry = useRef<{ file: File; session?: string; driveId?: string } | null>(null), lock = useRef(false);
  const [selectedTasks, setSelectedTasks] = useState<{ id: string; indexes: number[] }>({ id: "", indexes: [] });
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const callbacks = useRef({ onSelect, onReady, onBusy });
  useEffect(() => { callbacks.current = { onSelect, onReady, onBusy }; }, [onSelect, onReady, onBusy]);
  const effectiveId = onSelect ? selectedId : id;
  const [pollVersion, setPollVersion] = useState(0);
  useEffect(() => {
    if (!effectiveId) { callbacks.current.onReady?.(true); return; }
    let active = true, timer: ReturnType<typeof setTimeout>;
    callbacks.current.onReady?.(false);
    const poll = async () => {
      try {
        const result = await studioSourceStatusAction(effectiveId);
        if (!active) return;
        setSource(result); setPollError(""); callbacks.current.onReady?.(result.hasText);
        if (["queued", "indexing"].includes(result.status)) timer = setTimeout(poll, 5000);
      } catch { if (active) { setPollError("Не вдалося оновити стан. Файл збережено; перевіряємо знову."); timer = setTimeout(poll, 10000); } }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [effectiveId, pollVersion]);
  async function upload(file?: File) {
    if (lock.current) return;
    lock.current = true; setUploading(true); callbacks.current.onBusy?.(true); setError(""); setCanRetry(false);
    try {
      if (file) {
        const format = sourceFileFormat({ name: file.name, mimeType: file.type });
        if (!format) throw new Error(`Обери ${SOURCE_FILE_LABEL}.`);
        if (!file.size || file.size > MAX_UPLOAD_BYTES) throw new Error("Обери непорожній файл до 50 МБ.");
        if (format === "png" || format === "jpeg") {
          setPhase("Готуємо фото");
          const original = file;
          const prepared = await prepareStudioPhoto(new File([file], file.name, { type: SOURCE_MIME[format] }));
          file = prepared.type === original.type && prepared.size === original.size ? original : new File([prepared], original.name.replace(/\.[^.]+$/, prepared.type === "image/jpeg" ? ".jpg" : ".png"), { type: prepared.type });
        }
        retry.current = { file }; setPercent(0);
      }
      const saved = retry.current;
      if (!saved) return;
      setPhase(saved.driveId ? "Підтверджуємо збережений файл" : "Завантажуємо на твій Google Drive");
      const resuming = !!saved.session;
      const materialId = await withBusySignal(async () => {
        saved.session ??= await openSourceUpload(saved.file);
        saved.driveId ??= await putSourceUpload(saved.file, saved.session, setPercent, resuming);
        setPhase("Запускаємо обробку");
        return completeSourceUpload(saved.driveId);
      });
      setId(materialId); callbacks.current.onSelect?.({ id: materialId, title: saved.file.name });
      retry.current = null; setPickedFile(null); setPhase("");
    } catch (error) {
      const code = error instanceof SourceUploadError ? error.code : "";
      const messages: Record<string, string> = { not_configured: "Підключи Google Drive у налаштуваннях інтеграцій, щоб застосунок міг зберігати файли.", too_large: "Обери файл до 50 МБ.", unsupported_type: `Підтримуються ${SOURCE_FILE_LABEL}.` };
      setError(code ? messages[code] || "Не вдалося завершити завантаження. Повтори: використаємо збережену сесію, а не нову копію файла." : error instanceof Error ? error.message : "Не вдалося завантажити файл.");
      setCanRetry(!!retry.current);
    } finally { lock.current = false; setUploading(false); callbacks.current.onBusy?.(false); }
  }
  async function resume(ocr: boolean) {
    if (lock.current) return; lock.current = true; setUploading(true); setError("");
    try { await resumeStudioSourceAction(effectiveId, ocr); setSource(await studioSourceStatusAction(effectiveId)); setPollVersion(value => value + 1); }
    catch { setError("Не вдалося продовжити. Перевір бюджет і підключення ШІ; нового файла завантажувати не потрібно."); }
    finally { lock.current = false; setUploading(false); }
  }
  return <section aria-label="Завантаження джерела" className="min-w-0 space-y-3 rounded-2xl border border-p-line bg-p-surface p-4">
    <h3 className="font-bold">Додати файл із комп’ютера або телефона</h3>
    <p className="text-sm leading-relaxed text-p-muted">{SOURCE_FILE_LABEL}, до 50 МБ; фото — до 15 МБ із автоматичним зменшенням перед розпізнаванням. Файл збережеться на твоєму Google Drive, обробка почнеться автоматично. Для фото й сканів використовується платне розпізнавання в межах бюджету застосунку; великі скани потребують окремого підтвердження.</p>
    {enabled ? <label className="block text-sm font-bold">Вибрати матеріал<input aria-label="Файл-джерело для уроку" type="file" accept={SOURCE_FILE_ACCEPT} disabled={uploading} className="mt-2 block min-h-11 w-full max-w-full rounded-xl border border-p-line p-2 font-normal" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) { retry.current = null; setPickedFile(file); setError(""); setCanRetry(false); } }} /></label> : <p className="text-sm">Для завантаження підключи <Link href="/parent/settings" className="font-bold text-p-primary underline">Google Drive в налаштуваннях</Link>. Уже додані джерела й власний текст доступні нижче.</p>}
    {enabled && pickedFile && !uploading && !canRetry && <div className="space-y-2"><p className="break-words text-sm">{pickedFile.name} · {(pickedFile.size / 1024 / 1024).toFixed(1)} МБ</p><button type="button" onClick={() => void upload(pickedFile)} className={parentButton}>Завантажити й обробити матеріал</button></div>}
    {uploading && <div role="status" aria-live="polite" className="space-y-2"><p className="flex items-center gap-2 text-sm"><span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-p-line border-t-p-primary" />{phase || "Продовжуємо обробку…"}</p>{phase.includes("Google Drive") && <><progress aria-label="Завантаження файла" max={100} value={percent} className="h-2 w-full" /><p className="text-xs">{percent}%</p></>}</div>}
    {effectiveId && pollError && <p role="status" className="text-sm text-p-muted">{pollError}</p>}
    {error && <p role="alert" className="break-words rounded-xl border border-p-danger p-3 text-sm">{error}</p>}
    {canRetry && !uploading && <button type="button" onClick={() => void upload()} className={parentButton}>Повторити завершення завантаження</button>}
    {effectiveId && source?.id === effectiveId && <div className="min-w-0 space-y-3 rounded-xl border border-p-line p-3"><p className="break-words font-bold">{source.title}</p>
      <p role="status" className="text-sm">{source.hasText ? "✓ Текст доступний для підготовки уроку" : source.status === "scan_awaiting_ocr" ? "Потрібне підтвердження розпізнавання" : source.status === "deferred" ? "Обробка призупинена через бюджет" : source.status === "error" ? "Потрібна увага" : stages[source.progress?.step ?? ""] || "Матеріал у черзі обробки"}{["queued", "indexing"].includes(source.status) && <span aria-hidden="true" className="ml-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-p-line border-t-p-primary" />}</p>
      {source.pageCount !== null && <p className="text-xs text-p-muted">Сторінок / частин: {source.pageCount}{source.charCount !== null ? ` · символів: ${source.charCount}` : ""}</p>}
      {source.detail && <p className="text-sm text-p-muted">{source.detail}</p>}
      {source.warnings.map((warning, index) => <p key={index} className="text-sm text-p-muted">{warning}</p>)}
      {source.preview && <details><summary className="min-h-11 cursor-pointer py-2 text-sm font-bold">Перевірити розпізнаний текст</summary><pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-p-bg p-3 font-sans text-sm">{source.preview}</pre><p className="mt-2 text-xs text-p-muted">Це початок матеріалу для перевірки якості. Повний текст збережено в бібліотеці.</p></details>}
      {source.status === "scan_awaiting_ocr" && <><p className="text-sm">Розпізнати сторінок: {source.ocrPages}. Орієнтовна вартість: ${source.ocrCost.toFixed(3)}.</p><button type="button" disabled={uploading} onClick={() => void resume(true)} className={parentButton}>Погоджую розпізнавання — продовжити</button></>}
      {["error", "deferred", "scan_no_text"].includes(source.status) && <button type="button" disabled={uploading} onClick={() => void resume(false)} className={parentButton}>Повторити обробку збереженого файла</button>}
      {onTasks && !!source.tasks?.length && <fieldset className="space-y-2 rounded-xl border border-p-line p-3"><legend className="px-1 text-sm font-bold">Вправи з розпізнаної сторінки</legend>{source.tasks.map((task, index) => <label key={index} className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={selectedTasks.id === effectiveId && selectedTasks.indexes.includes(index)} onChange={event => { const indexes = selectedTasks.id === effectiveId ? selectedTasks.indexes : []; setSelectedTasks({ id: effectiveId, indexes: event.target.checked ? [...indexes, index] : indexes.filter(item => item !== index) }); }} /><span className="min-w-0 break-words"><strong>{task.label}</strong> · {task.text}</span></label>)}<button type="button" disabled={selectedTasks.id !== effectiveId || !selectedTasks.indexes.length} onClick={() => onTasks(source.tasks.filter((_, index) => selectedTasks.indexes.includes(index)).map(task => `${task.label}: ${task.text}`).join("\n\n"))} className={`${parentButton} disabled:opacity-50`}>Додати вибрані вправи до побажань</button></fieldset>}
      {!onSelect && source.hasText && <Link href={`/parent/studio/new?material=${source.id}`} className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Створити урок або курс із цього матеріалу →</Link>}
      <Link href={`/parent/books/${source.id}`} className="inline-flex min-h-11 items-center text-sm font-bold text-p-primary">Відкрити джерело в бібліотеці →</Link>
    </div>}
  </section>;
}
