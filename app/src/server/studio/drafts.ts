import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { STUDIO_MAX_BUDGET, studioRequestSchema } from "@/lib/studio";
import { forFamily } from "@/server/db/family-scope";
import { readStudioProject } from "./store";
import { startStudio } from "./workflow";

export const STUDIO_FORM_DRAFT = "studio.form_draft";
const uuid = z.string().uuid();
const revisionSchema = z.number().int().safe().nonnegative();
/** Raw form values remain editable: saving is not permission to run a model.
 * Empty number controls use 0; either page endpoint may be null or out of order.
 * Generation's stricter validation is deliberately applied only at launch. */
export const draftValuesSchema = z.object({
  mode: z.enum(["course", "extension", "revision"]),
  targetLanguage: z.enum(["en", "de"]).nullable().optional(),
  title: z.string().max(200), idea: z.string().max(20000), sourceText: z.string().max(40000),
  age: z.number().finite().min(0).max(18), grade: z.number().finite().min(0).max(12),
  lessonCount: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
  minutes: z.number().finite().min(0).max(45), budgetUsd: z.number().finite().min(0).max(STUDIO_MAX_BUDGET),
  subjectId: uuid.nullable(), topicId: uuid.nullable(), materialId: uuid.nullable(),
  pageFrom: z.number().finite().min(0).max(10000).nullable(), pageTo: z.number().finite().min(0).max(10000).nullable(),
  narratedDeck: z.boolean().optional(),
}).strict();
export type StudioDraftValues = z.infer<typeof draftValuesSchema>;
const payloadSchema = z.object({
  version: z.literal(1), revision: revisionSchema, values: draftValuesSchema,
  projectId: uuid.nullable(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
type Payload = z.infer<typeof payloadSchema>;
export type StudioFormDraft = Omit<Payload, "version"> & { id: string };
interface DraftRow { payload: unknown; locked_until: string | null }
const CONFLICT = "Чернетку вже змінено або її запуск уже розпочато. Онови сторінку перед повторною дією.";
export class StudioFormDraftConflictError extends Error {
  constructor() { super(CONFLICT); this.name = "StudioFormDraftConflictError"; }
}
function projectIdFor(familyId: string, draftId: string): string {
  const hex = createHash("sha256").update(`studio.form_draft.project:v1:${familyId.toLowerCase()}:${draftId.toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function record(id: string, payload: Payload): StudioFormDraft {
  return { id, revision: payload.revision, values: payload.values, projectId: payload.projectId, createdAt: payload.createdAt, updatedAt: payload.updatedAt };
}
async function readRow(familyId: string, id: string): Promise<{ payload: Payload; lockedUntil: string | null } | null> {
  uuid.parse(id);
  const { data, error } = await forFamily(familyId).select("jobs", "payload,locked_until")
    .eq("id", id).eq("type", STUDIO_FORM_DRAFT).eq("status", "done").maybeSingle<DraftRow>();
  if (error) throw new Error("Не вдалося прочитати збережене заповнення Майстерні.");
  if (!data) return null;
  const parsed = payloadSchema.safeParse(data.payload);
  if (!parsed.success) throw new Error("Збережене заповнення має невідомий формат. Не перезаписуй його; звернися по допомогу.");
  return { payload: parsed.data, lockedUntil: data.locked_until };
}
export async function readStudioFormDraft(familyId: string, id: string): Promise<StudioFormDraft | null> {
  const row = await readRow(familyId, id);
  return row ? record(id, row.payload) : null;
}
export async function listStudioFormDrafts(familyId: string): Promise<StudioFormDraft[]> {
  const { data, error } = await forFamily(familyId).select("jobs", "id,payload")
    .eq("type", STUDIO_FORM_DRAFT).eq("status", "done")
    .order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(50)
    .returns<{ id: string; payload: unknown }[]>();
  if (error) throw new Error("Не вдалося прочитати список збережених заповнень.");
  return (data ?? []).flatMap(row => {
    const parsed = payloadSchema.safeParse(row.payload);
    return parsed.success ? [record(row.id, parsed.data)] : [];
  });
}
export async function saveStudioFormDraft(familyId: string, id: string, expectedRevision: number | null, rawValues: unknown): Promise<StudioFormDraft> {
  uuid.parse(id); revisionSchema.nullable().parse(expectedRevision);
  const values = draftValuesSchema.parse(rawValues);
  const scope = forFamily(familyId);
  if (expectedRevision === null) {
    const timestamp = new Date().toISOString();
    const payload: Payload = { version: 1, revision: 0, values, projectId: null, createdAt: timestamp, updatedAt: timestamp };
    const { data, error } = await scope.insert("jobs", { id, type: STUDIO_FORM_DRAFT, status: "done", payload })
      .select("id").single<{ id: string }>();
    if (error?.code === "23505") {
      const previous = await readStudioFormDraft(familyId, id);
      if (previous && JSON.stringify(previous.values) === JSON.stringify(values)) return previous;
      throw new StudioFormDraftConflictError();
    }
    if (error || !data) throw new Error("Не вдалося зберегти заповнення Майстерні. Спробуй ще раз.");
    return record(id, payload);
  }
  const row = await readRow(familyId, id);
  if (!row || row.payload.revision !== expectedRevision || row.payload.projectId || row.lockedUntil) throw new StudioFormDraftConflictError();
  // If a response was lost after durable project creation, editing this form
  // must not turn a later retry into a second/different generation request.
  if (await readStudioProject(familyId, projectIdFor(familyId, id))) throw new StudioFormDraftConflictError();
  const payload: Payload = { ...row.payload, values, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
  const { data, error } = await scope.update("jobs", { payload }).eq("id", id)
    .eq("type", STUDIO_FORM_DRAFT).eq("status", "done")
    .eq("payload->>revision", String(expectedRevision)).is("payload->>projectId", null).is("locked_until", null)
    .select("id").maybeSingle<{ id: string }>();
  if (error || !data) throw new StudioFormDraftConflictError();
  return record(id, payload);
}
export async function launchStudioFormDraft(familyId: string, id: string, revision: number): Promise<string> {
  uuid.parse(id); revisionSchema.parse(revision);
  const row = await readRow(familyId, id);
  if (!row) throw new StudioFormDraftConflictError();
  if (row.payload.projectId) {
    // Accept both the original launch revision and a freshly loaded linked
    // draft, but not a stale revision from before another saved edit.
    if (revision !== row.payload.revision && revision !== row.payload.revision - 1) throw new StudioFormDraftConflictError();
    return row.payload.projectId;
  }
  if (revision !== row.payload.revision) throw new StudioFormDraftConflictError();
  const values = row.payload.values;
  const request = studioRequestSchema.parse({ ...values, topicId: values.mode === "course" ? null : values.topicId,
    lessonCount: values.mode === "course" ? values.lessonCount : 1 });
  const now = new Date();
  if (row.lockedUntil && Date.parse(row.lockedUntil) > now.getTime()) throw new StudioFormDraftConflictError();
  const lease = new Date(now.getTime() + 10 * 60_000).toISOString();
  const scope = forFamily(familyId);
  let claim = scope.update("jobs", { locked_until: lease }).eq("id", id).eq("type", STUDIO_FORM_DRAFT)
    .eq("status", "done").eq("payload->>revision", String(revision)).is("payload->>projectId", null);
  claim = row.lockedUntil === null ? claim.is("locked_until", null) : claim.eq("locked_until", row.lockedUntil);
  const claimed = await claim.select("id").maybeSingle<{ id: string }>();
  if (claimed.error || !claimed.data) throw new StudioFormDraftConflictError();
  try {
    const projectId = await startStudio(familyId, request, projectIdFor(familyId, id));
    const payload: Payload = { ...row.payload, revision: revision + 1, projectId, updatedAt: new Date().toISOString() };
    const saved = await scope.update("jobs", { payload, locked_until: null }).eq("id", id)
      .eq("type", STUDIO_FORM_DRAFT).eq("status", "done").eq("payload->>revision", String(revision))
      .eq("locked_until", lease).is("payload->>projectId", null).select("id").maybeSingle<{ id: string }>();
    if (saved.error || !saved.data) {
      const latest = await readStudioFormDraft(familyId, id);
      if (latest?.projectId === projectId) return projectId;
      throw new StudioFormDraftConflictError();
    }
    return projectId;
  } catch (error) {
    // Never unlock a newer holder's claim after this invocation timed out.
    try { await scope.update("jobs", { locked_until: null }).eq("id", id).eq("type", STUDIO_FORM_DRAFT)
      .eq("status", "done").eq("payload->>revision", String(revision)).eq("locked_until", lease); }
    catch { /* Durable form retained; an expired launch can be retried with the same project ID. */ }
    throw error;
  }
}
