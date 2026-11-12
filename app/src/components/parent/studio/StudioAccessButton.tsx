"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { setStudioAccessAction } from "@/app/actions/studio";
export function StudioAccessButton({ id, revision, visible, disabled = false, onChanged, onBusy }: { id: string; revision: number; visible: boolean; disabled?: boolean; onChanged?: () => Promise<void>; onBusy?: (value: boolean) => void }) {
  const router = useRouter(); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  async function change() {
    if (lock.current || disabled) return; lock.current = true; setPending(true); onBusy?.(true); setError("");
    try { const result = await setStudioAccessAction({ id, revision, enabled: !visible }); if (result.status === "error") setError(result.message); else { if (onChanged) await onChanged(); router.refresh(); } }
    catch { setError("Не вдалося підтвердити зміну доступу. Онови сторінку."); }
    finally { lock.current = false; setPending(false); onBusy?.(false); }
  }
  return <div><button type="button" disabled={pending || disabled} onClick={() => { void change(); }} className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 text-sm font-bold disabled:opacity-50">{pending ? "Змінюємо доступ…" : visible ? "Вимкнути для дитини" : "Увімкнути для дитини"}</button>{error && <p role="alert" className="mt-2 text-sm text-p-danger">{error}</p>}</div>;
}
