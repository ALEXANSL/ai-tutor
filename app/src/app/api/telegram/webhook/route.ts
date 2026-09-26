import { NextResponse } from "next/server";
import { getServerSecret } from "@/server/env";
import { notifyParent } from "@/server/notifications";
import { consumeLinkCode, isTelegramWebhookAuthorized, parseStartCommand, storeLinkedChatId, type TelegramUpdate } from "@/server/notify/telegram";

/**
 * Telegram Bot API webhook (ADR-010, US-11.7 КП-4): binds a chat only via a
 * fresh one-time code sent to a private chat; any other message is silently
 * ignored — the bot never replies to, or discloses anything to, anyone else,
 * and accepts no configuration commands.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = getServerSecret("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) return NextResponse.json({ ok: false }, { status: 503 });
  if (!isTelegramWebhookAuthorized(request.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const parsed = update && parseStartCommand(update);
  if (!parsed) return NextResponse.json({ ok: true }); // ignored — not a "/start <code>" in a private chat.

  const familyId = await consumeLinkCode(parsed.code);
  if (!familyId) return NextResponse.json({ ok: true }); // unknown/expired/used code — silently ignored.

  await storeLinkedChatId(familyId, String(parsed.chatId));
  await notifyParent(familyId, { type: "telegram_linked", severity: "normal", payload: {} }).catch((e: Error) =>
    console.error(`telegram_linked notification failed: ${e.message}`),
  );
  return NextResponse.json({ ok: true });
}
