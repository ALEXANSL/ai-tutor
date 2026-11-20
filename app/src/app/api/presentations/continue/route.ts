import { z } from "zod";
import { isCronAuthorized } from "@/server/jobs/cron-auth";
import { getServerSecret } from "@/server/env";
import { deckWakeToken } from "@/server/decks/wake-auth";
import { kickDeck } from "@/server/decks/kick";
export const maxDuration = 300;
export async function POST(req: Request) {
  const secret = getServerSecret("CRON_SECRET");
  const input = z.object({ familyId: z.string().uuid(), id: z.string().uuid() }).safeParse(await req.json().catch(() => null));
  if (!input.success) return new Response(null, { status: 400 });
  const auth = req.headers.get("authorization");
  if (!isCronAuthorized(auth, secret) && !isCronAuthorized(auth, deckWakeToken(input.data.familyId, input.data.id))) return new Response(null, { status: 403 });
  kickDeck(input.data.familyId, input.data.id);
  return new Response(null, { status: 202 });
}
