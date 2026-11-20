import { z } from "zod";
import { isCronAuthorized } from "@/server/jobs/cron-auth";
import { getServerSecret } from "@/server/env";
import { kickDeck } from "@/server/decks/kick";
export const maxDuration = 300;
export async function POST(req: Request) {
  const secret = getServerSecret("CRON_SECRET");
  if (!secret || !isCronAuthorized(req.headers.get("authorization"), secret)) return new Response(null, { status: 403 });
  const input = z.object({ familyId: z.string().uuid(), id: z.string().uuid() }).safeParse(await req.json());
  if (!input.success) return new Response(null, { status: 400 });
  kickDeck(input.data.familyId, input.data.id);
  return new Response(null, { status: 202 });
}
