import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FamilyScope } from "@/server/db/family-scope";

const metadata = z.object({
  kind: z.literal("lesson_voice_session"), childId: z.string(), revision: z.number().int().nonnegative(),
  target: z.record(z.string(), z.unknown()), expires_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(), busy_until: z.string().datetime().nullable(), claim: z.string().nullable(),
});
type Metadata = z.infer<typeof metadata>;
export interface VoiceLease extends Metadata { id: string }
const deadline = () => new Date(Date.now() + 60_000).toISOString();

/** Lease state belongs to a server-created system message in the existing
 * topic journal. No schema changes or client write policies are needed. */
export async function createLease(scope: FamilyScope, childId: string, chatId: string, target: Record<string, unknown>): Promise<VoiceLease> {
  const meta: Metadata = { kind: "lesson_voice_session", childId, revision: 0, target, expires_at: deadline(), ended_at: null, busy_until: null, claim: null };
  const { data, error } = await scope.client.from("messages").insert({ family_id: scope.familyId, chat_id: chatId, author: "system", type: "system", content: "🎙 Голосова розмова під час уроку", meta }).select("id").single<{ id: string }>();
  if (error || !data) throw new Error("voice_unavailable");
  return { ...meta, id: data.id };
}
export async function readLease(scope: FamilyScope, childId: string, id: string, allowEnded = false): Promise<VoiceLease> {
  const { data, error } = await scope.select("messages", "id,meta").eq("id", id).eq("author", "system").eq("type", "system")
    .eq("meta->>kind", "lesson_voice_session").eq("meta->>childId", childId).maybeSingle<{ id: string; meta: unknown }>();
  const parsed = metadata.safeParse(data?.meta);
  if (error || !data || !parsed.success || parsed.data.childId !== childId) throw new Error("voice_expired");
  const lease = { ...parsed.data, id: data.id };
  if (!allowEnded && (lease.ended_at || Date.parse(lease.expires_at) <= Date.now())) throw new Error("voice_expired");
  return lease;
}

async function changeLease(scope: FamilyScope, childId: string, id: string, change: (old: VoiceLease) => Metadata | null, allowEnded = false): Promise<VoiceLease> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const old = await readLease(scope, childId, id, allowEnded);
    const next = change(old);
    if (!next) return old;
    const meta = metadata.parse({ ...next, revision: old.revision + 1 });
    const { data, error } = await scope.update("messages", { meta }).eq("id", id).eq("author", "system").eq("type", "system")
      .eq("meta->>kind", "lesson_voice_session").eq("meta->>childId", childId).eq("meta->>revision", String(old.revision))
      .select("id").maybeSingle<{ id: string }>();
    if (error) throw new Error("voice_unavailable");
    if (data) return { ...meta, id };
    // Another turn/heartbeat/stop won the row. Re-read; never revive its old state.
  }
  throw new Error("voice_expired");
}
export const renewLease = (scope: FamilyScope, childId: string, id: string) => changeLease(scope, childId, id, old => ({ ...old, expires_at: deadline() }));
export const stopLease = (scope: FamilyScope, childId: string, id: string) => changeLease(scope, childId, id, old => old.ended_at ? null : ({ ...old, ended_at: new Date().toISOString() }), true);
export const claimLease = (scope: FamilyScope, childId: string, id: string) => changeLease(scope, childId, id, old => {
  if (old.busy_until && Date.parse(old.busy_until) > Date.now()) throw new Error("voice_expired");
  return { ...old, busy_until: new Date(Date.now() + 120_000).toISOString(), claim: randomUUID() };
});
export const releaseLease = (scope: FamilyScope, childId: string, id: string, claim: string | null) => changeLease(scope, childId, id,
  old => old.claim !== claim ? null : ({ ...old, busy_until: null, claim: null }), true);
