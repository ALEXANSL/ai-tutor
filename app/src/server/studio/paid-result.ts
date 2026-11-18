import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { StudioPendingModelCall } from "@/lib/studio";

export interface StudioPaidModelResult { result: unknown; model: { provider: string; model: string }; costUsd: number; failure?: { code: string; paths: string[] } }
const TYPE = "studio.model_result";
const MAX_RESULT_BYTES = 500000;
interface Receipt extends StudioPaidModelResult {
  version: 1;
  familyId: string;
  projectId: string;
  callId: string;
  inputHash: string;
  phase: StudioPendingModelCall["phase"];
  cursor: number;
  digest: string;
}
interface Row { id: string; type: string; status: string; payload: unknown }
const invalid = () => new Error("STUDIO-RESULT: збережений оплачений результат не узгоджується з етапом або пошкоджений. Повторний платний виклик цим кроком не запускається.");
const unavailable = () => new Error("STUDIO-RESULT-STORE: не вдалося підтвердити збереження оплаченого результату. Резерв слід зберегти; повторний платний виклик цим кроком не запускається.");
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();

/** JSONB reorders object keys. Hash stable JSON, reject values JSON cannot faithfully persist. */
function canonical(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) throw invalid();
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  if (encoded === undefined) throw invalid();
  return encoded;
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function checkCall(familyId: string, projectId: string, pending: StudioPendingModelCall): void {
  if (!nonempty(familyId) || !isUuid(projectId) || !pending || !isUuid(pending.id) || !nonempty(pending.inputHash) || !nonempty(pending.phase)
      || !Number.isSafeInteger(pending.cursor) || pending.cursor < 0 || !Number.isFinite(pending.reservedUsd) || pending.reservedUsd < 0 || typeof pending.billed !== "boolean") throw invalid();
}
function checkedResult(value: unknown): StudioPaidModelResult {
  const result = value as Partial<StudioPaidModelResult> | null;
  if (!result || typeof result !== "object" || !Object.hasOwn(result, "result") || !result.model || typeof result.model !== "object"
      || !nonempty(result.model.provider) || !nonempty(result.model.model) || typeof result.costUsd !== "number" || !Number.isFinite(result.costUsd) || result.costUsd < 0) throw invalid();
  if (Buffer.byteLength(canonical(result.result)) > MAX_RESULT_BYTES) throw new Error("STUDIO-RESULT-SIZE: оплачений результат перевищує місткість збереження. Резерв слід зберегти; автоматичного повторного виклику немає.");
  const failure = result.failure;
  if (failure && (!["STUDIO-AI-INCOMPLETE", "STUDIO-AI-REFUSAL", "STUDIO-AI-JSON", "STUDIO-AI-OUTPUT-SCHEMA", "STUDIO-AI-NO-OUTPUT", "STUDIO-AI-RESPONSE-STATE"].includes(failure.code) || !Array.isArray(failure.paths) || failure.paths.length > 8 || failure.paths.some(path => typeof path !== "string" || path.length > 400 || !/^[a-zA-Z0-9_.]+$/.test(path)))) throw invalid();
  return { ...(failure ? { failure: { code: failure.code, paths: [...failure.paths] } } : {}), result: result.result, model: { provider: result.model.provider, model: result.model.model }, costUsd: result.costUsd };
}
function receipt(familyId: string, projectId: string, pending: StudioPendingModelCall, value: StudioPaidModelResult): Receipt {
  const body = { version: 1 as const, familyId, projectId: projectId.toLowerCase(), callId: pending.id.toLowerCase(), inputHash: pending.inputHash,
    phase: pending.phase, cursor: pending.cursor, ...checkedResult(value) };
  return { ...body, digest: digest(body) };
}

/** The pending call's ID is reserved in the project before contacting a provider.
 * This immutable write never settles money or advances the project; the caller owns those CAS steps. */
export async function writeStudioPaidResult(familyId: string, projectId: string, pending: StudioPendingModelCall, result: StudioPaidModelResult): Promise<void> {
  checkCall(familyId, projectId, pending);
  let expected: Receipt;
  try { expected = receipt(familyId, projectId, pending, result); }
  catch (error) { if (error instanceof Error && error.message.startsWith("STUDIO-RESULT")) throw error; throw invalid(); }
  const scope = forFamily(familyId);
  const { error } = await scope.client.from("jobs").upsert({ id: pending.id.toLowerCase(), family_id: familyId, type: TYPE, status: "done", payload: expected }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw unavailable();
  const saved = await readStudioPaidResult(familyId, projectId, pending);
  if (!saved || canonical(saved) !== canonical(checkedResult(result))) throw invalid();
}

/** Missing is distinct from wrong context/corruption. Do not turn a mismatched receipt into a new paid call. */
export async function readStudioPaidResult(familyId: string, projectId: string, pending: StudioPendingModelCall): Promise<StudioPaidModelResult | null> {
  checkCall(familyId, projectId, pending);
  const { data, error } = await forFamily(familyId).select("jobs", "id,type,status,payload").eq("id", pending.id.toLowerCase()).maybeSingle<Row>();
  if (error) throw unavailable();
  if (!data) return null;
  try {
    const payload = data.payload as Receipt | null;
    if (data.id !== pending.id.toLowerCase() || data.type !== TYPE || data.status !== "done" || !payload || payload.version !== 1
        || payload.familyId !== familyId || payload.projectId !== projectId.toLowerCase() || payload.callId !== pending.id.toLowerCase()
        || payload.inputHash !== pending.inputHash || payload.phase !== pending.phase || payload.cursor !== pending.cursor) throw invalid();
    const result = checkedResult(payload);
    const expected = receipt(familyId, projectId, pending, result);
    if (payload.digest !== expected.digest || canonical(payload) !== canonical(expected)) throw invalid();
    return result;
  } catch (error) { if (error instanceof Error && error.message.startsWith("STUDIO-RESULT")) throw error; throw invalid(); }
}
