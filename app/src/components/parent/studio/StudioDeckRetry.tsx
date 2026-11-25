"use client";

import { useActionState } from "react";
import { retryStudioPresentation } from "@/app/actions/studio";
import { idleState } from "@/app/actions/state";
import { parentButton } from "@/app/parent/ui";

export function StudioDeckRetry({ projectId, lessonId }: { projectId: string; lessonId: string }) {
  const [state, action, pending] = useActionState(retryStudioPresentation.bind(null, projectId, lessonId), idleState);
  return <form action={action}>
    <button type="submit" className={parentButton} disabled={pending}>{pending ? "Ставимо в чергу…" : "Повторити запуск презентації"}</button>
    {state.status === "error" && <p role="alert" className="mt-1 text-sm">{state.message}</p>}
  </form>;
}
