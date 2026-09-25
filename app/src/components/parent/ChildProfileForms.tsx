"use client";

import { useActionState, useState } from "react";
import { parentSaveNicknameAction, parentSaveTutorNameAction } from "@/app/actions/parent";
import { idleState } from "@/app/actions/state";
import { FormMessage } from "@/components/FormMessage";
import { uk, type TutorGender } from "@/i18n/uk";
import { DEFAULT_TUTOR_GENDER, gendered } from "@/lib/persona/gender";
import type { TutorNameOptions } from "@/server/db/types";

const input =
  "min-h-11 w-full rounded-xl border border-p-line bg-p-bg px-3 text-[15px] text-p-text outline-none focus:border-p-primary";
const button = "inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60";
const label = "mb-1.5 block text-xs font-bold text-p-muted uppercase";

/** Parent edits the child's nickname (US-1.6 KP-3 "Змінити"). */
export function ParentNicknameForm({ nickname }: { nickname: string | null }) {
  const [state, action, pending] = useActionState(parentSaveNicknameAction, idleState);
  const t = uk.parent.child;
  return (
    <form action={action} id="nickname" className="flex flex-col gap-2">
      <label htmlFor="parent-nickname" className={label}>
        {t.nickname}
      </label>
      <div className="flex gap-2">
        <input id="parent-nickname" name="nickname" defaultValue={nickname ?? ""} maxLength={40} className={input} />
        <button type="submit" disabled={pending} className={button}>
          {t.save}
        </button>
      </div>
      <p className="text-xs text-p-muted">{t.nicknameHelp}</p>
      <FormMessage state={state} />
    </form>
  );
}

/** Parent changes the tutor's name (US-1.7 KP-11): a suggestion or an own name (same rules). */
export function ParentTutorNameForm({
  options,
  current,
  currentGender = DEFAULT_TUTOR_GENDER,
}: {
  options: TutorNameOptions;
  current: string | null;
  currentGender?: TutorGender;
}) {
  const [state, action, pending] = useActionState(parentSaveTutorNameAction, idleState);
  const suggested = [...options.f, ...options.m].map((o) => o.name);
  const [choice, setChoice] = useState(current && suggested.includes(current) ? `suggested:${current}` : "custom");
  const t = uk.parent.child;
  const p = uk.child.tutorNamePicker;
  return (
    <form action={action} className="flex flex-col gap-2">
      <label htmlFor="parent-tutor-choice" className={label}>
        {t.tutorName}
      </label>
      <select
        id="parent-tutor-choice"
        name="choice"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
        className={input}
      >
        {options.f.length > 0 && (
          <optgroup label={p.groupF}>
            {options.f.map((o) => (
              <option key={o.name} value={`suggested:${o.name}`}>
                {o.name}
              </option>
            ))}
          </optgroup>
        )}
        {options.m.length > 0 && (
          <optgroup label={p.groupM}>
            {options.m.map((o) => (
              <option key={o.name} value={`suggested:${o.name}`}>
                {o.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value="custom">{p.custom}</option>
      </select>
      {choice === "custom" && (
        <>
          <input
            name="custom"
            aria-label={p.custom}
            defaultValue={current && !suggested.includes(current) ? current : ""}
            placeholder={p.customPlaceholder}
            maxLength={40}
            className={input}
          />
          <label htmlFor="parent-tutor-gender" className={label}>
            {p.genderLabel}
          </label>
          <select id="parent-tutor-gender" name="gender" defaultValue={currentGender} className={input}>
            {(["f", "m"] as const).map((g) => (
              <option key={g} value={g}>
                {gendered(g, p.gender)} — «{gendered(g, uk.ai.roleNoun)}»
              </option>
            ))}
          </select>
        </>
      )}
      <div>
        <button type="submit" disabled={pending} className={button}>
          {t.save}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}
