"use client";

import { useState, useTransition } from "react";
import { prepareTopicAction } from "@/app/actions/lesson";
import { uk } from "@/i18n/uk";

/**
 * US-19.5 КП-2 (S38): "Підготувати" on a "Потрібна підготовка" topic card
 * (`/subject/[id]`) — queues background generation via `prepareTopicAction`
 * WITHOUT navigating the child into the lesson/warming screen (the whole
 * point of this entry point — she can go do something else while it's
 * ready). Once queued, this button gets out of the way and lets the
 * server-rendered badge (КП-1's three-state model) carry the status instead
 * of duplicating it here.
 */
export function PrepareTopicButton({ subjectId, topicId }: { subjectId: string; topicId: string }) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "queued" | "error">("idle");
  const t = uk.child.subject.prepare;

  function prepare() {
    setState("idle");
    startTransition(async () => {
      const result = await prepareTopicAction(subjectId, topicId);
      if (result.status === "error") {
        setState("error");
        return;
      }
      setState("queued");
    });
  }

  if (state === "queued") {
    return <p className="text-sm font-semibold text-secondary">{t.confirmation}</p>;
  }

  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={prepare}
        className="inline-flex min-h-11 items-center rounded-2xl border border-line bg-surface px-4 text-sm font-bold text-text disabled:opacity-60"
      >
        {pending ? t.preparing : t.button}
      </button>
      {state === "error" && <p className="mt-2 text-sm font-semibold text-danger">{t.error}</p>}
    </div>
  );
}
