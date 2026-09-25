"use client";

import { useActionState } from "react";
import { setPinAction } from "@/app/actions/parent";
import { idleState } from "@/app/actions/state";
import { FormMessage } from "@/components/FormMessage";
import { uk } from "@/i18n/uk";

const input =
  "min-h-11 w-40 rounded-xl border border-p-line bg-p-bg px-3 text-center text-lg tracking-[0.4em] text-p-text outline-none focus:border-p-primary";

/** Set / change the parent-mode PIN (US-1.5 KP-5). Only rendered for the parent's own account. */
export function PinForm() {
  const [state, action, pending] = useActionState(setPinAction, idleState);
  const t = uk.parent.settings;
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        {(
          [
            ["pin", t.pinNew],
            ["repeat", t.pinRepeat],
          ] as const
        ).map(([name, labelText]) => (
          <label key={name} className="flex flex-col gap-1.5 text-xs font-bold text-p-muted uppercase">
            {labelText}
            <input
              name={name}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="\d{4,6}"
              minLength={4}
              maxLength={6}
              required
              className={input}
            />
          </label>
        ))}
      </div>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60"
        >
          {t.pinSave}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
