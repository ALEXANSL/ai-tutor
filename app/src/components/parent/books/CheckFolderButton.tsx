"use client";

import { useActionState } from "react";
import { checkFolderAction } from "@/app/actions/books";
import { idleState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";

/** "Я додав — перевірити папку" (US-2.7 KP-4). */
export function CheckFolderButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const [state, action, pending] = useActionState(checkFolderAction, idleState);
  const t = uk.parent.books.add;
  const cls =
    variant === "primary"
      ? "bg-p-primary text-white"
      : "border border-p-line bg-p-surface text-p-text";
  return (
    <form action={action} className="flex flex-col gap-2">
      <button
        type="submit"
        disabled={pending}
        className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-4 text-[14px] font-bold disabled:opacity-60 ${cls}`}
      >
        {pending ? t.checking : `🔄 ${t.check}`}
      </button>
      {state.status !== "idle" && state.message && (
        <p role={state.status === "error" ? "alert" : "status"} className={`text-[13px] font-bold ${state.status === "ok" ? "text-p-success" : "text-p-danger"}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
