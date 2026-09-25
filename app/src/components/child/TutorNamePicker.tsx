"use client";

import { useActionState, useState } from "react";
import type { FormState } from "@/app/actions/state";
import { idleState } from "@/app/actions/state";
import { FormMessage } from "@/components/FormMessage";
import { uk, type TutorGender } from "@/i18n/uk";
import { DEFAULT_TUTOR_GENDER, gendered } from "@/lib/persona/gender";
import type { TutorNameOptions } from "@/server/db/types";
import { primaryButton } from "./ChildCard";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * Suggested names (female / male groups, PM-21) + "own name" (US-1.7 KP-2, KP-3).
 * Custom names are checked on the server; a rejection is explained kindly
 * and the parent is informed there, so the client never pre-filters them.
 * An own name comes with an explicit "Вона / Він" (default "Вона"): until a
 * voice is chosen (S12) it sets the tutor's grammatical gender (BUG-002).
 */
export function TutorNamePicker({
  options,
  current,
  currentGender = DEFAULT_TUTOR_GENDER,
  action: serverAction,
  submitLabel,
}: {
  options: TutorNameOptions;
  current: string | null;
  currentGender?: TutorGender;
  action: Action;
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState(serverAction, idleState);
  const suggested = [...options.f, ...options.m].map((o) => o.name);
  const initialChoice =
    current && suggested.includes(current) ? `suggested:${current}` : current ? "custom" : suggested[0] ? `suggested:${suggested[0]}` : "custom";
  const [choice, setChoice] = useState(initialChoice);
  const [custom, setCustom] = useState(current && !suggested.includes(current) ? current : "");
  const [gender, setGender] = useState<TutorGender>(currentGender);
  const t = uk.child.tutorNamePicker;

  const card = (selected: boolean) =>
    `flex min-h-14 cursor-pointer items-center gap-3.5 rounded-[18px] border-2 px-4 py-3.5 text-left ${
      selected ? "border-primary bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface-alt))]" : "border-line bg-surface-alt"
    }`;

  const group = (title: string, list: TutorNameOptions["f"]) =>
    list.length > 0 && (
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</legend>
        {list.map((o) => {
          const value = `suggested:${o.name}`;
          return (
            <label key={o.name} className={card(choice === value)}>
              <input
                type="radio"
                name="choice"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="sr-only"
              />
              <span className="tutor-avatar h-11 w-11 flex-none text-xl" aria-hidden="true">
                <span className="tutor-avatar__core">✦</span>
              </span>
              <span>
                <b className="block text-[17px]">{o.name}</b>
                {o.hint && <span className="text-sm text-muted">{o.hint}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
    );

  return (
    <form action={action} className="flex flex-col gap-4 text-left">
      {group(t.groupF, options.f)}
      {group(t.groupM, options.m)}
      <label className={card(choice === "custom")}>
        <input
          type="radio"
          name="choice"
          value="custom"
          checked={choice === "custom"}
          onChange={() => setChoice("custom")}
          className="sr-only"
        />
        <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-surface text-xl" aria-hidden="true">
          ✏️
        </span>
        <span className="flex-1">
          <b className="block text-[17px]">{t.custom}</b>
          <input
            name="custom"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              setChoice("custom");
            }}
            onFocus={() => setChoice("custom")}
            placeholder={t.customPlaceholder}
            maxLength={40}
            autoComplete="off"
            aria-label={t.custom}
            className="mt-1 w-full rounded-xl border-2 border-line bg-bg px-3 py-2.5 text-base text-text outline-none focus:border-focus"
          />
          <span className="mt-1 block text-xs text-muted">{t.customHint}</span>
        </span>
      </label>
      {choice === "custom" && (
        <fieldset className="flex flex-col gap-2" data-testid="tutor-gender">
          <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{t.genderLabel}</legend>
          <div className="grid grid-cols-2 gap-3">
            {(["f", "m"] as const).map((g) => (
              <label key={g} className={card(gender === g)}>
                <input
                  type="radio"
                  name="gender"
                  value={g}
                  checked={gender === g}
                  onChange={() => setGender(g)}
                  className="sr-only"
                />
                <span>
                  <b className="block text-[17px]">{gendered(g, t.gender)}</b>
                  <span className="text-sm text-muted">«{gendered(g, uk.ai.roleNoun)}»</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <FormMessage state={state} />
      <button type="submit" className={primaryButton} disabled={pending || (choice === "custom" && custom.trim().length === 0)}>
        {submitLabel}
      </button>
    </form>
  );
}
