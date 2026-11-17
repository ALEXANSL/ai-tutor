"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { wakeStudioWorkspaceAction } from "@/app/actions/studio-activity";
export function StudioWorkQueue() {
  const router = useRouter(); const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await wakeStudioWorkspaceAction(); if (!alive) return; setNotice(result.active ? `Незалежно готуються проєкти: ${result.active}. Можна створювати наступні; поточні продовжують роботу.` : "Фонову чергу перевірено."); router.refresh(); }
      catch { if (alive) setNotice("Не вдалося оновити чергу. Збережені завдання не скасовано."); }
      if (alive) timer = setTimeout(poll, 20000);
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [router]);
  return <p role="status" className="mb-4 text-sm text-p-muted">{notice || "Перевіряємо фонові проєкти…"}</p>;
}
