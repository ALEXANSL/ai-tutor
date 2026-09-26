"use client";

import { useState, useTransition } from "react";
import { createTelegramLinkAction, sendTestUrgentNotificationAction, unlinkTelegramAction } from "@/app/actions/parent";
import { uk } from "@/i18n/uk";

/**
 * "Термінові сповіщення" (US-11.7): status of both channels, "Прив'язати
 * Telegram" (opens the bot chat with a fresh one-time code), "Відв'язати",
 * and "Надіслати тестове термінове сповіщення" (КП-5).
 */
export function UrgentChannelsPanel({
  emailConfigured,
  telegramLinked,
}: {
  emailConfigured: boolean;
  telegramLinked: boolean;
}) {
  const t = uk.parent.settings.telegram;
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function link() {
    startTransition(async () => {
      const res = await createTelegramLinkAction();
      if (res.status === "ok") {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        setMessage(res.message);
      }
    });
  }

  function unlink() {
    startTransition(async () => {
      await unlinkTelegramAction();
      setMessage(t.unlinked);
    });
  }

  function test() {
    startTransition(async () => {
      const res = await sendTestUrgentNotificationAction();
      setMessage(res.message);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold">{emailConfigured ? uk.parent.settings.emailConfigured : uk.parent.settings.emailNotConfigured}</p>
      <p className="text-sm font-bold">{telegramLinked ? t.linked : t.notLinked}</p>
      <div className="flex flex-wrap gap-2">
        {!telegramLinked ? (
          <button
            type="button"
            disabled={pending}
            onClick={link}
            className="min-h-11 rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60"
          >
            {t.link}
          </button>
        ) : (
          <button type="button" disabled={pending} onClick={unlink} className="min-h-11 rounded-xl border border-p-line px-4 text-[14px] font-bold">
            {t.unlink}
          </button>
        )}
        <button type="button" disabled={pending} onClick={test} className="min-h-11 rounded-xl border border-p-line px-4 text-[14px] font-bold">
          {t.test}
        </button>
      </div>
      {!telegramLinked && <p className="text-xs text-p-muted">{t.linkHint}</p>}
      {message && (
        <p className="text-[13px] text-p-muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
