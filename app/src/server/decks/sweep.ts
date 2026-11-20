import "server-only";
import { createServiceClient } from "@/server/supabase/clients";
import { DECK_TYPE, getDeck } from "./store";
import { reconcileDeck } from "./recovery";
import { legacyDeckRetry } from "./retry";

/** Adopt presentations created before durable deliveries, even with all tabs closed. */
export async function recoverDeckQueue() {
  const db = createServiceClient();
  let cursor: string | undefined;
  for (;;) {
    let query = db.from("jobs").select("id,family_id,state:payload->>state,error:payload->>error")
      .eq("type", DECK_TYPE).in("payload->>state", ["processing", "error"]).order("id").limit(50);
    if (cursor) query = query.gt("id", cursor);
    const { data, error } = await query.returns<{ id: string; family_id: string; state: string; error: string }[]>();
    if (error) throw new Error("Presentation queue recovery lookup failed");
    for (const row of data) {
      if (row.state === "error" && !legacyDeckRetry(row.error)) continue;
      try {
        const deck = await getDeck(row.family_id, row.id);
        if (deck) await reconcileDeck(row.family_id, row.id, deck);
      } catch { console.warn("Presentation reconciliation deferred", row.id); }
    }
    if (data.length < 50) return;
    cursor = data[data.length - 1]!.id;
  }
}
