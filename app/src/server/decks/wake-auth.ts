import "server-only";
import { createHmac } from "node:crypto";
import { requireServiceRoleKey } from "@/server/env";

/** Scoped to one deck, never send the underlying service credential. */
export function deckWakeToken(familyId: string, id: string) {
  return createHmac("sha256", requireServiceRoleKey()).update(JSON.stringify(["deck-continuation-v1", familyId, id])).digest("hex");
}
