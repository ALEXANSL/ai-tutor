"use client";

import { useActionState, useState } from "react";
import { saveNicknameAction } from "@/app/actions/child";
import { idleState } from "@/app/actions/state";
import { FormMessage } from "@/components/FormMessage";
import { uk } from "@/i18n/uk";
import { validateNickname } from "@/lib/persona/validation";
import { primaryButton, textInput } from "./ChildCard";

/** Nickname input with a friendly live hint (US-1.6 KP-1); the server re-validates. */
export function NicknameForm({ initial, submitLabel }: { initial?: string | null; submitLabel: string }) {
  const [state, action, pending] = useActionState(saveNicknameAction, idleState);
  const [value, setValue] = useState(initial ?? "");
  const check = value.trim().length > 0 ? validateNickname(value) : null;
  const liveError = check && !check.ok && check.error !== "too_short" ? uk.validation.nickname[check.error] : null;
  const t = uk.child.onboarding.nickname;
  return (
    <form action={action} className="text-left">
      <label htmlFor="nickname" className="sr-only">
        {t.title}
      </label>
      <input
        id="nickname"
        name="nickname"
        className={textInput}
        placeholder={t.placeholder}
        autoComplete="off"
        autoCapitalize="words"
        maxLength={40}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-describedby="nickname-hint"
      />
      <p id="nickname-hint" className="mt-1.5 mb-3 text-sm text-muted">
        {t.hint}
      </p>
      {liveError && (
        <p className="mb-3 text-sm font-bold text-danger" role="alert">
          {liveError}
        </p>
      )}
      <FormMessage state={state} className="mb-3" />
      <button type="submit" className={primaryButton} disabled={pending || !check?.ok}>
        {submitLabel}
      </button>
    </form>
  );
}
