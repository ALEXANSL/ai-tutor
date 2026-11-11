"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { schoolPacketSchema, type SchoolPacket, type SchoolConnection } from "@/lib/eschool";
import { importSchoolAction, disconnectSchoolAction } from "@/app/actions/eschool";
import { parentButton } from "@/app/parent/ui";
export function SchoolImport({ connection }: { connection: SchoolConnection | null }) {
  const router = useRouter(); const [packet, setPacket] = useState<SchoolPacket | null>(null); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [pending, setPending] = useState(false); const [reading, setReading] = useState(false);
  const [pasted, setPasted] = useState("");
  const [bookmark, setBookmark] = useState("");
  const nonce = useRef(""); const timer = useRef<ReturnType<typeof setTimeout> | null>(null); const lock = useRef(false);
  function accept(raw: unknown) {
    const parsed = schoolPacketSchema.safeParse(raw);
    if (!parsed.success) { setError("Формат пакета не розпізнано. Завантаж останню версію помічника й повтори читання."); return; }
    setPacket(parsed.data); setPasted(""); setError(""); setNotice("");
  }
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "AI_TUTOR_ESCHOOL_RESULT" || event.data.nonce !== nonce.current || !nonce.current) return;
      if (timer.current) clearTimeout(timer.current); nonce.current = ""; setReading(false);
      if (event.data.packet) accept(event.data.packet); else setError("Помічник не має свіжих даних. Запусти його у вкладці щоденника або завантаж збережений JSON.");
    };
    window.addEventListener("message", receive); return () => { window.removeEventListener("message", receive); if (timer.current) clearTimeout(timer.current); };
  }, []);
  async function copyBookmark() {
    setError("");
    try {
      const response = await fetch("/eschool-mobile-bookmark.txt", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const text = await response.text(); if (!text.startsWith("javascript:")) throw new Error();
      setBookmark(text);
      try { await navigator.clipboard.writeText(text); setNotice("Посилання помічника скопійовано. Встав його в поле URL закладки Chrome."); }
      catch { setNotice("Скопіюй посилання з поля нижче й встав у URL закладки Chrome."); }
    } catch { setError("Не вдалося завантажити мобільного помічника. Онови сторінку й повтори."); }
  }
  function pastedPreview() { try { accept(JSON.parse(pasted)); } catch { setError("Не вдалося прочитати дані. Скопіюй їх кнопкою в мобільному помічнику та встав повністю."); } }
  function read() {
    if (reading || pending) return; setReading(true); setError(""); nonce.current = crypto.randomUUID();
    window.postMessage({ type: "AI_TUTOR_ESCHOOL_READ", nonce: nonce.current }, window.location.origin);
    timer.current = setTimeout(() => { nonce.current = ""; setReading(false); setError("Не вдалося зв’язатися з помічником. Перевір установлення й онови цю сторінку. Або завантаж JSON, збережений помічником."); }, 4000);
  }
  async function file(file?: File) {
    if (!file) return; setError("");
    if (file.size > 1800000) { setError("Пакет завеликий. Обери коротший період у помічнику."); return; }
    try { accept(JSON.parse(await file.text())); } catch { setError("Не вдалося прочитати JSON помічника."); }
  }
  async function save() {
    if (!packet || lock.current) return; lock.current = true; setPending(true); setError("");
    try { const result = await importSchoolAction(packet); if (result.status !== "ok") { setError(result.message); return; } setNotice(result.repeated ? "Цей пакет уже імпортовано — дублі не створені." : `Імпортовано ${result.count} записів. Дитина бачить їх у розділі «Шкільний щоденник».`); setPacket(null); router.refresh(); }
    catch { setError("Не вдалося підтвердити імпорт. Онови сторінку перед повтором; той самий пакет можна імпортувати без дублювання."); }
    finally { lock.current = false; setPending(false); }
  }
  async function disconnect() {
    if (lock.current) return; lock.current = true; setPending(true);
    try { const result = await disconnectSchoolAction(); if (result.status === "error") setError(result.message); else { setNotice("Підключення відключено. Збережені уроки, ДЗ та їхні статуси залишились."); router.refresh(); } }
    finally { lock.current = false; setPending(false); }
  }
  return <section className="mb-6 space-y-4 rounded-2xl border border-p-line bg-p-surface p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-bold">Єдина школа — пробне підключення</h2><p className="mt-1 text-sm text-p-muted">{connection?.identity ? `Підключено профіль учня №${connection.identity.pupilId}${connection.identity.classLabel ? ` · ${connection.identity.classLabel}` : ""}` : "Ще не підключено"}</p>{connection?.lastSync && <p className="mt-1 text-xs text-p-muted">Останній імпорт: {new Date(connection.lastSync).toLocaleString("uk-UA", { timeZone: "Europe/Kiev" })}</p>}</div>{connection?.identity && <button disabled={pending} onClick={() => { void disconnect(); }} className="min-h-11 rounded-xl border border-p-line px-3 text-sm">Відключити профіль</button>}</div>
    <details className="rounded-xl border border-p-line p-4" open={!connection?.lastSync}><summary className="cursor-pointer font-bold">На Android-телефоні: помічник як закладка Chrome</summary><p className="mt-3 text-sm text-p-muted">Розширення для комп’ютера на телефоні не потрібне. Створюємо одну закладку, яка читатиме відкритий щоденник.</p><button type="button" onClick={() => { void copyBookmark(); }} disabled={pending} className={`${parentButton} mt-3`}>Скопіювати посилання мобільного помічника</button><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm"><li>Збережи цю сторінку в закладки Chrome: меню ⋮ → значок ⭐.</li><li>У меню «Закладки» натисни ⋮ біля неї → «Редагувати»: назва <strong>Щоденник</strong>, у поле <strong>URL / Адреса</strong> встав щойно скопійоване посилання повністю.</li><li>Відкрий <a href="https://diary.eschool-ua.com/" target="_blank" rel="noreferrer" className="text-p-primary underline">щоденник</a> і ввійди. У його адресному рядку введи <strong>Щоденник</strong> та обери збережену закладку зі значком ⭐ у підказках.</li><li>У вікні помічника натисни «Прочитати мій тиждень» → «Скопіювати дані для репетитора» → «Відкрити репетитор».</li><li>Тут встав дані в поле нижче, переглянь і підтвердь імпорт.</li></ol>{bookmark && <details className="mt-3"><summary className="cursor-pointer text-sm">Посилання для ручного копіювання</summary><textarea readOnly value={bookmark} onFocus={event => event.target.select()} rows={3} className="mt-2 w-full rounded-xl border border-p-line bg-p-bg p-2 text-xs" aria-label="Посилання мобільного помічника" /></details>}<p className="mt-3 text-xs text-p-muted">Працює у відкритому вебщоденнику, а не всередині окремого додатка. На першому запуску перевіряємо сумісність твого браузера.</p></details>
    <div className="rounded-xl border border-p-line p-4"><label className="block text-sm font-bold">Дані зі щоденника<textarea value={pasted} onChange={event => setPasted(event.target.value)} rows={3} maxLength={1800000} placeholder="Натисни й утримуй поле → Вставити" className="mt-2 w-full rounded-xl border border-p-line bg-p-bg p-3 font-normal" /></label><button type="button" disabled={pending || !pasted.trim()} onClick={pastedPreview} className={`${parentButton} mt-3`}>Переглянути вставлені дані</button></div>
    <details className="rounded-xl border border-p-line p-4"><summary className="cursor-pointer font-bold">На комп’ютері: розширення Chrome / Edge</summary><ol className="mt-3 list-decimal space-y-2 pl-5 text-sm"><li><a href="/eschool-helper.zip" download className="font-bold text-p-primary underline">Завантаж помічник</a> і розпакуй ZIP у папку.</li><li>Відкрий <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>), увімкни «Режим розробника» → «Завантажити розпаковане розширення». Обери папку з <code>manifest.json</code>.</li><li>Увійди на <a href="https://diary.eschool-ua.com/" target="_blank" rel="noreferrer" className="text-p-primary underline">diary.eschool-ua.com</a> як завжди та обери профіль дитини. Натисни іконку помічника в меню розширень біля адресного рядка.</li><li>Прочитай поточний тиждень. Тут натисни «Отримати дані з помічника», переглянь записи й підтвердь імпорт.</li></ol><p className="mt-3 text-xs leading-relaxed text-p-muted">Помічник не отримує пароль і не передає cookies. Читає тільки щоденник активного учня. Пробна версія для комп’ютера, синхронізація запускається вручну. Автоматичного cron або здачі ДЗ у школу немає.</p></details>
    <div className="flex flex-wrap gap-3"><button type="button" disabled={reading || pending} onClick={read} className={parentButton}>{reading ? "Зв’язуємося з помічником…" : "Отримати дані з помічника"}</button><label className="inline-flex min-h-11 cursor-pointer items-center rounded-xl border border-p-line px-4 text-sm font-bold">Завантажити JSON помічника<input type="file" accept=".json,application/json" className="sr-only" disabled={pending} onChange={event => { void file(event.target.files?.[0]); event.target.value = ""; }} /></label></div>
    {error && <p role="alert" className="text-sm text-p-danger">{error}</p>}{notice && <p role="status" className="text-sm font-bold text-p-primary">{notice}</p>}
    {connection?.warnings.map((warning, index) => <p key={index} className="text-sm text-p-muted">{warning}</p>)}
    {packet && <div className="space-y-3 border-t border-p-line pt-4"><h3 className="font-bold">Перевір перед імпортом</h3><p className="text-sm text-p-muted">Профіль учня №{packet.identity.pupilId} · {packet.range.start} — {packet.range.end} · уроків {packet.entries.filter(entry => entry.kind === "lesson").length}, ДЗ {packet.entries.filter(entry => entry.kind === "homework").length}</p>{packet.warnings.map((warning, i) => <p key={i} className="text-sm text-p-danger">{warning}</p>)}<div className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-p-line p-3">{packet.entries.map(entry => <article key={entry.externalId} className="rounded-lg bg-p-bg p-3 text-sm"><p className="font-bold">{entry.subject} · {entry.kind === "homework" ? "ДЗ" : "урок"} · {entry.lessonDate}</p>{entry.dueDate && <p>Термін: {entry.dueDate}</p>}<p className="mt-1 break-words">{entry.topic}</p><p className="mt-1 whitespace-pre-wrap break-words">{entry.text || (entry.kind === "homework" ? "Опис не отримано — перевір оригінал." : "")}</p></article>)}</div><p className="text-xs text-p-muted">Повторний імпорт оновлює записи. Власні статуси виконання зберігаються. Правильність першого читання перевіряємо на цьому перегляді.</p><button type="button" disabled={pending} onClick={() => { void save(); }} className={parentButton}>{pending ? "Імпортуємо…" : "Імпортувати знайдені уроки та ДЗ"}</button></div>}
  </section>;
}
