"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { enterParentModeAction } from "@/app/actions/parent-mode";
import { idleState, type FormState } from "@/app/actions/state";
import { uk } from "@/i18n/uk";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin-format";

/**
 * "Режим тата" entry on the child's tablet (US-1.5 KP-1, KP-6): a quiet
 * button out of the way of the child's main actions; no PIN hints.
 */
export function ParentModeButton() {
  const [open, setOpen] = useState(false);
  const t = uk.child.parentMode;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-40 flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 py-2.5 font-parent text-[13px] font-semibold text-muted shadow-sm"
      >
        {t.button}
      </button>
      {open && <PinDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function PinDialog({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [state, action, pending] = useActionState(async (prev: FormState, formData: FormData) => {
    const result = await enterParentModeAction(prev, formData);
    // Clear the entered digits after any failed attempt.
    if (result.status === "error") setPin("");
    return result;
  }, idleState);
  const formRef = useRef<HTMLFormElement>(null);
  const t = uk.child.parentMode;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (/^\d$/.test(e.key)) setPin((p) => (p.length < PIN_MAX_LENGTH ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") formRef.current?.requestSubmit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const press = (digit: string) => setPin((p) => (p.length < PIN_MAX_LENGTH ? p + digit : p));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="pin-title">
      <form ref={formRef} action={action} className="w-full max-w-[340px] rounded-3xl bg-surface p-7 text-center">
        <h2 id="pin-title" className="text-xl font-extrabold">
          {t.title}
        </h2>
        <p className="mt-1 text-muted">{t.prompt}</p>
        <input type="hidden" name="pin" value={pin} />
        <div className="my-5 flex justify-center gap-3.5" aria-live="polite" aria-label={`${pin.length}`}>
          {Array.from({ length: Math.max(PIN_MIN_LENGTH, pin.length) }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full border-2 ${i < pin.length ? "border-primary bg-primary" : "border-line"}`}
            />
          ))}
        </div>
        <p role="alert" className="mb-3 min-h-5 text-sm font-bold text-danger">
          {state.status === "error" ? state.message : ""}
        </p>
        <div className="grid grid-cols-3 gap-2.5">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
            <PadKey key={d} onClick={() => press(d)}>
              {d}
            </PadKey>
          ))}
          <PadKey onClick={() => setPin((p) => p.slice(0, -1))} label={t.erase}>
            ⌫
          </PadKey>
          <PadKey onClick={() => press("0")}>0</PadKey>
          <button
            type="submit"
            disabled={pending || pin.length < PIN_MIN_LENGTH}
            aria-label={t.submit}
            className="min-h-14 rounded-2xl bg-primary text-xl font-bold text-white disabled:opacity-50"
          >
            ✓
          </button>
        </div>
        <button type="button" onClick={onClose} className="mt-3 min-h-12 w-full rounded-2xl bg-surface-alt font-bold">
          {t.cancel}
        </button>
      </form>
    </div>
  );
}

function PadKey({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="min-h-14 rounded-2xl border border-line bg-surface-alt text-xl font-bold text-text active:scale-95"
    >
      {children}
    </button>
  );
}
