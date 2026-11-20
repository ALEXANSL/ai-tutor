"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startDeck } from "@/app/actions/narrated-decks";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { openSourceUpload, putSourceUpload, sourceUploadErrorMessage } from "@/lib/upload-source";
import { withBusySignal } from "@/lib/busy-signal";
import { parentButton, parentInput } from "@/app/parent/ui";

export function DeckUpload({ subjects }: { subjects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [subject, setSubject] = useState(""), [file, setFile] = useState<File>(), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0), [message, setMessage] = useState("");
  const upload = useRef<{ session?: string; driveId?: string }>({});
  const lock = useRef(false);
  async function start() {
    if (lock.current || !file || !subject) return;
    if (!/\.pptx$/i.test(file.name) || !file.size || file.size > MAX_UPLOAD_BYTES) { setMessage("Обери непорожній файл PPTX до 50 МБ."); return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      const id = await withBusySignal(async () => {
        const saved = upload.current;
        const resume = !!saved.session;
        saved.session ??= await openSourceUpload(file);
        saved.driveId ??= await putSourceUpload(file, saved.session, setProgress, resume);
        return startDeck(saved.driveId, subject);
      });
      router.push(`/parent/studio/presentations/${id}`);
    } catch (error) { setMessage(sourceUploadErrorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="space-y-4">
    <label className="block font-bold">Предмет<select className={parentInput} value={subject} disabled={busy} onChange={e => setSubject(e.target.value)}><option value="">Оберіть предмет</option>{subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label className="block font-bold">Авторська презентація<input type="file" accept=".pptx" className={parentInput} disabled={busy} onChange={e => { setFile(e.target.files?.[0]); upload.current = {}; setMessage(""); setProgress(0); }} /></label>
    <button className={parentButton} disabled={!subject || !file || busy} onClick={start}>{busy ? `Завантаження · ${progress}%` : "Підготувати озвучення слайдів"}</button>
    {message && <p role="alert">{message}</p>}
  </div>;
}
