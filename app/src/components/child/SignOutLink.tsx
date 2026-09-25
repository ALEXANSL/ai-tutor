"use client";

import { useState } from "react";
import { uk } from "@/i18n/uk";

/**
 * BUG-004 (b): an unobtrusive way to leave the account from the child's
 * interface — needed on a shared tablet before the parent has set a PIN.
 * Confirms inline before posting to /auth/signout (same route the cabinet
 * uses), which clears the Supabase session and any parent-mode cookie.
 */
export function SignOutLink() {
  const [confirming, setConfirming] = useState(false);
  const t = uk.child.myTutor.signOut;

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="mt-4 text-xs font-semibold text-muted underline underline-offset-2">
        {t.link}
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-2xl border border-line bg-surface-alt p-3.5 text-center">
      <p className="mb-1 text-sm font-bold">{t.confirmTitle}</p>
      <p className="mb-3 text-xs text-muted">{t.confirmBody}</p>
      <div className="flex justify-center gap-2">
        <form action="/auth/signout" method="post">
          <button type="submit" className="min-h-11 rounded-xl bg-danger px-4 text-sm font-bold text-white">
            {t.yes}
          </button>
        </form>
        <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-xl bg-surface px-4 text-sm font-bold text-text">
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
