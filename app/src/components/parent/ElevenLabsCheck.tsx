"use client";

import { useActionState } from "react";
import { checkElevenLabsAction } from "@/app/actions/elevenlabs";
import { idleState } from "@/app/actions/state";
import { parentButton } from "@/app/parent/ui";

/** Button on the budget page: one tiny real ElevenLabs call that explains a failure in plain words. */
export function ElevenLabsCheck() {
  const [state, action, pending] = useActionState(checkElevenLabsAction, idleState);
  return (
    <form action={action} className="space-y-2">
      <p className="text-sm text-p-muted">Якщо в журналі ElevenLabs позначено «Помилка», а озвучує резервна модель OpenAI, натисніть кнопку: застосунок вимовить одне коротке речення і пояснить, що не так.</p>
      <button type="submit" disabled={pending} className={parentButton}>{pending ? "Перевіряю…" : "Перевірити голос ElevenLabs"}</button>
      {state.status !== "idle" && state.message ? (
        <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>{state.message}</p>
      ) : null}
    </form>
  );
}
