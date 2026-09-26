import "server-only";
import { timingSafeEqual } from "node:crypto";
import { getServerSecret } from "@/server/env";
import { createServiceClient } from "@/server/supabase/clients";

/**
 * Telegram Bot API, called directly (ADR-010: no wrapper library needed for
 * two methods). Pure helpers below are unit-tested without network; the
 * `fetch`-calling functions take a `fetchImpl` for the same reason.
 */

/** Webhook auth: `X-Telegram-Bot-Api-Secret-Token` must match exactly (constant-time). */
export function isTelegramWebhookAuthorized(header: string | null, secret: string | null): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(secret);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A random, URL-safe one-time code, valid 10 minutes (ADR-010). */
export function generateLinkCode(randomBytesHex: string): string {
  return randomBytesHex.slice(0, 24);
}

export const LINK_CODE_TTL_MINUTES = 10;

export interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id: number; type: string };
  };
}

/** Only a private chat sending exactly "/start <code>" can bind (ADR-010, US-11.7 КП-4). */
export function parseStartCommand(update: TelegramUpdate): { code: string; chatId: number } | null {
  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text || msg.chat?.type !== "private") return null;
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
  if (!m) return null;
  return { code: m[1]!, chatId: msg.chat.id };
}

let cachedUsername: { at: number; username: string | null } | null = null;
const USERNAME_TTL_MS = 60 * 60_000;

/** `getMe` once per hour — avoids a second env var (`TELEGRAM_BOT_USERNAME`) just for the `t.me/<bot>?start=` link. */
export async function getTelegramBotUsername(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const token = getServerSecret("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  if (cachedUsername && Date.now() - cachedUsername.at < USERNAME_TTL_MS) return cachedUsername.username;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
    const username = res.ok && body?.ok ? (body.result?.username ?? null) : null;
    cachedUsername = { at: Date.now(), username };
    return username;
  } catch {
    return null;
  }
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: { status: number | null; message: string } }> {
  const token = getServerSecret("TELEGRAM_BOT_TOKEN");
  if (!token) return { ok: false, error: { status: null, message: "TELEGRAM_BOT_TOKEN не налаштовано" } };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: { status: res.status, message: body.slice(0, 300) || `telegram error ${res.status}` } };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: { status: null, message: (e as Error).message } };
  }
}

/** Bot token used as the pgcrypto passphrase for the encrypted chat id column (see the S4 migration). */
function chatIdPassphrase(): string | null {
  return getServerSecret("TELEGRAM_BOT_TOKEN");
}

export async function getLinkedChatId(familyId: string): Promise<string | null> {
  const passphrase = chatIdPassphrase();
  if (!passphrase) return null;
  const { data, error } = await createServiceClient().rpc("get_telegram_chat_id", {
    p_family_id: familyId,
    p_passphrase: passphrase,
  });
  if (error) {
    console.error(`get_telegram_chat_id failed: ${error.message}`);
    return null;
  }
  return (data as string | null) ?? null;
}

export async function storeLinkedChatId(familyId: string, chatId: string): Promise<void> {
  const passphrase = chatIdPassphrase();
  if (!passphrase) throw new Error("TELEGRAM_BOT_TOKEN не налаштовано");
  const { error } = await createServiceClient().rpc("set_telegram_chat_id", {
    p_family_id: familyId,
    p_chat_id: chatId,
    p_passphrase: passphrase,
  });
  if (error) throw new Error(`set_telegram_chat_id failed: ${error.message}`);
}

export async function unlinkChatId(familyId: string): Promise<void> {
  const { error } = await createServiceClient().rpc("clear_telegram_chat_id", { p_family_id: familyId });
  if (error) throw new Error(`clear_telegram_chat_id failed: ${error.message}`);
}

/** US-11.7 КП-1: a one-time code (10 min) that `t.me/<bot>?start=<code>` carries to the webhook. */
export async function createLinkCode(familyId: string): Promise<string> {
  const code = generateLinkCode(crypto.randomUUID().replace(/-/g, ""));
  const { error } = await createServiceClient()
    .from("telegram_link_codes")
    .insert({ family_id: familyId, code, expires_at: new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000).toISOString() });
  if (error) throw new Error(`createLinkCode failed: ${error.message}`);
  return code;
}

/** Consumes a still-valid, unused code exactly once; returns the family it belongs to. */
export async function consumeLinkCode(code: string): Promise<string | null> {
  const db = createServiceClient();
  const { data, error } = await db
    .from("telegram_link_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("family_id")
    .maybeSingle<{ family_id: string }>();
  if (error) {
    console.error(`consumeLinkCode failed: ${error.message}`);
    return null;
  }
  return data?.family_id ?? null;
}
