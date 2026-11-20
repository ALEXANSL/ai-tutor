import { handleCallback } from "@vercel/queue";
import { z } from "zod";
import { consumeDeck, WaitForDeck } from "@/server/decks/kick";

export const maxDuration = 300;
const message = z.object({ familyId: z.string().uuid(), id: z.string().uuid(), jobId: z.string().uuid() });
const consume = handleCallback(async raw => {
  await consumeDeck(message.parse(raw));
}, {
  visibilityTimeoutSeconds: 300,
  retry: error => ({ afterSeconds: error instanceof WaitForDeck ? error.seconds : 30 }),
});

export function POST(request: Request) {
  return consume(request);
}
