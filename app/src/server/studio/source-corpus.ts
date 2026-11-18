import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { StudioSource } from "@/lib/studio";

export interface SourceNote { source: StudioSource; fromPart: number; toPart: number; quotes?: { sourceId: string; text: string }[] }
export interface CorpusSnapshot {
  id: string;
  partCount: number;
  chunkCount: number;
  characterCount: number;
  blankChunks: number;
  pageFrom: number | null;
  pageTo: number | null;
}

export const STUDIO_SOURCE_PART_BYTES = 60000;
const SOURCE_BYTES = STUDIO_SOURCE_PART_BYTES - 2048;
const MAX_SOURCES_PER_PART = 200;
const PART_TYPE = "studio.source_part";
const NOTE_TYPE = "studio.source_note";
const IO_BATCH = 5;
interface PartPayload { version: 1; familyId: string; corpusId: string; corpus: CorpusSnapshot; index: number; sources: StudioSource[]; digest: string }
interface NotePayload { version: 1; familyId: string; corpusId: string; note: SourceNote; digest: string }
interface StoredRow { id: string; type: string; payload: unknown }
interface WriteRow { id: string; type: string; status: "done"; payload: PartPayload | NotePayload }

const unavailable = () => new Error("Збережений текст джерела або його аналіз недоступний чи пошкоджений. Частини не обрізалися; підготовку зупинено.");
/** Stable object ordering makes source identity independent of JS property insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function uuid(value: unknown): string {
  const hex = digest(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function partId(familyId: string, corpusId: string, index: number): string { return uuid([PART_TYPE, familyId, corpusId, index]); }
function noteId(familyId: string, corpusId: string, note: SourceNote): string { return uuid([NOTE_TYPE, familyId, corpusId, note]); }
function validSource(value: unknown): value is StudioSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<StudioSource>;
  return typeof source.id === "string" && !!source.id && typeof source.title === "string" && typeof source.text === "string"
    && typeof source.kind === "string" && !!source.kind
    && (source.page === null || (Number.isSafeInteger(source.page) && Number(source.page) >= 1))
    && (source.audience === undefined || ["learner", "teacher", "reference"].includes(source.audience));
}
function validCorpus(value: CorpusSnapshot): boolean {
  return !!value && typeof value.id === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value.id)
    && [value.partCount, value.chunkCount, value.characterCount, value.blankChunks].every(n => Number.isSafeInteger(n) && n >= 0)
    && value.blankChunks <= value.chunkCount
    && [value.pageFrom, value.pageTo].every(n => n === null || (Number.isSafeInteger(n) && Number(n) >= 1))
    && ((value.pageFrom === null && value.pageTo === null) || (value.pageFrom !== null && value.pageTo !== null && value.pageFrom <= value.pageTo));
}
/** Workflow progress extends this descriptor; only immutable snapshot fields
 * participate in corpus integrity, never mutable analysis cursors or note refs. */
function corpusMetadata(corpus: CorpusSnapshot): CorpusSnapshot {
  return { id: corpus.id, partCount: corpus.partCount, chunkCount: corpus.chunkCount,
    characterCount: corpus.characterCount, blankChunks: corpus.blankChunks,
    pageFrom: corpus.pageFrom, pageTo: corpus.pageTo };
}
function validNote(note: SourceNote, corpus: CorpusSnapshot): boolean {
  return !!note && validSource(note.source) && Number.isSafeInteger(note.fromPart) && Number.isSafeInteger(note.toPart)
    && note.fromPart >= 0 && note.fromPart <= note.toPart && note.toPart < corpus.partCount
    && (note.quotes === undefined || (Array.isArray(note.quotes) && note.quotes.every(quote => quote && typeof quote.sourceId === "string" && !!quote.sourceId && typeof quote.text === "string" && !!quote.text)));
}
function safeEnd(text: string, index: number): number {
  // Never split a UTF-16 surrogate pair; ordinary combining characters remain lossless too.
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1]!) && /[\uDC00-\uDFFF]/.test(text[index]!) ? index - 1 : index;
}
function splitSource(source: StudioSource): StudioSource[] {
  if (Buffer.byteLength(canonical(source)) <= SOURCE_BYTES - 2) return [{ ...source }];
  const segments: StudioSource[] = [];
  let offset = 0;
  while (offset < source.text.length) {
    const id = `${source.id}#part-${segments.length + 1}`;
    let low = 0, high = Math.min(source.text.length - offset, SOURCE_BYTES), best = 0;
    while (low <= high) {
      const units = Math.floor((low + high) / 2);
      const end = safeEnd(source.text, offset + units);
      const candidate = { ...source, id, text: source.text.slice(offset, end) };
      if (Buffer.byteLength(canonical(candidate)) <= SOURCE_BYTES - 2) { best = end - offset; low = units + 1; }
      else high = units - 1;
    }
    if (best < 1) throw new Error("Опис одного фрагмента джерела завеликий. Повний текст не обрізався.");
    segments.push({ ...source, id, text: source.text.slice(offset, offset + best) });
    offset += best;
  }
  if (!segments.length) throw new Error("Опис порожнього фрагмента джерела завеликий. Повний текст не обрізався.");
  return segments;
}

/** Byte and count limits are transport partitions, never a page/lesson or source-content cap. */
export function packStudioSources(sources: StudioSource[]): StudioSource[][] {
  const parts: StudioSource[][] = [];
  const originalIds = new Set<string>();
  const packedIds = new Set<string>();
  let part: StudioSource[] = [], size = 2;
  for (const source of sources) {
    if (!validSource(source) || originalIds.has(source.id)) throw new Error("Неузгоджені фрагменти джерела. Повний текст не обрізався.");
    originalIds.add(source.id);
    for (const segment of splitSource(source)) {
      if (packedIds.has(segment.id)) throw new Error("Неоднозначні ідентифікатори фрагментів джерела.");
      packedIds.add(segment.id);
      const bytes = Buffer.byteLength(canonical(segment));
      if (part.length && (part.length === MAX_SOURCES_PER_PART || size + bytes + 1 > SOURCE_BYTES)) { parts.push(part); part = []; size = 2; }
      part.push(segment); size += bytes + (part.length > 1 ? 1 : 0);
    }
  }
  if (part.length) parts.push(part);
  return parts;
}

function checkedPart(row: StoredRow, familyId: string, corpusId: string, expected?: CorpusSnapshot, index?: number): PartPayload {
  const part = row.payload as PartPayload;
  if (row.type !== PART_TYPE || !part || part.version !== 1 || part.familyId !== familyId || part.corpusId !== corpusId
      || !validCorpus(part.corpus) || part.corpus.id !== corpusId || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= part.corpus.partCount
      || row.id !== partId(familyId, corpusId, part.index) || (index !== undefined && part.index !== index)
      || (expected && canonical(corpusMetadata(part.corpus)) !== canonical(corpusMetadata(expected)))
      || !Array.isArray(part.sources) || !part.sources.length || part.sources.length > MAX_SOURCES_PER_PART || !part.sources.every(validSource)
      || part.digest !== digest(part.sources) || Buffer.byteLength(canonical(part)) > STUDIO_SOURCE_PART_BYTES) throw unavailable();
  return part;
}
async function loadRows(familyId: string, type: string, corpusId: string, ids: string[]): Promise<StoredRow[]> {
  const { data, error } = await forFamily(familyId).select("jobs", "id,type,payload").eq("type", type).eq("payload->>corpusId", corpusId).in("id", ids).returns<StoredRow[]>();
  if (error || !data || data.length !== ids.length || new Set(data.map(row => row.id)).size !== ids.length) throw unavailable();
  return data;
}
async function saveImmutable(familyId: string, corpusId: string, rows: WriteRow[]): Promise<void> {
  const scope = forFamily(familyId);
  for (let offset = 0; offset < rows.length; offset += IO_BATCH) {
    const batch = rows.slice(offset, offset + IO_BATCH);
    for (const row of batch) if (Buffer.byteLength(canonical(row.payload)) > STUDIO_SOURCE_PART_BYTES) throw new Error("Один збережений фрагмент джерела завеликий. Текст не обрізався.");
    const { error } = await scope.client.from("jobs").upsert(batch.map(row => ({ ...row, family_id: familyId })), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error("Не вдалося зберегти повний текст джерела або його аналіз. Попередні частини залишилися збереженими.");
    // Ignore-duplicate writes never repair or overwrite an immutable version.
    // Verify any preexisting row is precisely the content this hash identifies.
    const saved = await loadRows(familyId, batch[0]!.type, corpusId, batch.map(row => row.id));
    const byId = new Map(saved.map(row => [row.id, row]));
    for (const row of batch) if (canonical(byId.get(row.id)?.payload) !== canonical(row.payload)) throw unavailable();
  }
}

export async function snapshotStudioSources(familyId: string, sources: StudioSource[]): Promise<CorpusSnapshot> {
  const parts = packStudioSources(sources);
  let pageFrom: number | null = null, pageTo: number | null = null;
  for (const source of sources) if (source.page !== null) { pageFrom = pageFrom === null ? source.page : Math.min(pageFrom, source.page); pageTo = pageTo === null ? source.page : Math.max(pageTo, source.page); }
  const corpus: CorpusSnapshot = {
    id: uuid(["studio.source_corpus.v1", familyId, sources]), partCount: parts.length, chunkCount: sources.length,
    characterCount: sources.reduce((sum, source) => sum + source.text.length, 0), blankChunks: sources.filter(source => !source.text.trim()).length,
    pageFrom, pageTo,
  };
  const rows: WriteRow[] = parts.map((part, index) => ({ id: partId(familyId, corpus.id, index), type: PART_TYPE, status: "done", payload: { version: 1, familyId, corpusId: corpus.id, corpus, index, sources: part, digest: digest(part) } }));
  await saveImmutable(familyId, corpus.id, rows);
  return corpus;
}
export async function readStudioSourcePart(familyId: string, corpus: CorpusSnapshot, index: number): Promise<StudioSource[]> {
  if (!validCorpus(corpus) || !Number.isSafeInteger(index) || index < 0 || index >= corpus.partCount) throw unavailable();
  const rows = await loadRows(familyId, PART_TYPE, corpus.id, [partId(familyId, corpus.id, index)]);
  return checkedPart(rows[0]!, familyId, corpus.id, corpus, index).sources;
}
async function readCorpusMetadata(familyId: string, corpusId: string): Promise<CorpusSnapshot> {
  const rows = await loadRows(familyId, PART_TYPE, corpusId, [partId(familyId, corpusId, 0)]);
  return checkedPart(rows[0]!, familyId, corpusId, undefined, 0).corpus;
}
export async function writeStudioSourceNote(familyId: string, corpusId: string, note: SourceNote): Promise<string> {
  const corpus = await readCorpusMetadata(familyId, corpusId);
  if (!validNote(note, corpus)) throw new Error("Аналіз посилається на недоступні частини джерела. Підготовку зупинено.");
  const id = noteId(familyId, corpusId, note);
  await saveImmutable(familyId, corpusId, [{ id, type: NOTE_TYPE, status: "done", payload: { version: 1, familyId, corpusId, note, digest: digest(note) } }]);
  return id;
}
export async function readStudioSourceNotes(familyId: string, corpusId: string, refs: string[]): Promise<SourceNote[]> {
  if (!refs.length) return [];
  if (new Set(refs).size !== refs.length) throw unavailable();
  const corpus = await readCorpusMetadata(familyId, corpusId);
  const found = new Map<string, SourceNote>();
  for (let offset = 0; offset < refs.length; offset += IO_BATCH) {
    for (const row of await loadRows(familyId, NOTE_TYPE, corpusId, refs.slice(offset, offset + IO_BATCH))) {
      const payload = row.payload as NotePayload;
      if (row.type !== NOTE_TYPE || !payload || payload.version !== 1 || payload.familyId !== familyId || payload.corpusId !== corpusId
          || !validNote(payload.note, corpus) || payload.digest !== digest(payload.note)
          || row.id !== noteId(familyId, corpusId, payload.note) || Buffer.byteLength(canonical(payload)) > STUDIO_SOURCE_PART_BYTES) throw unavailable();
      found.set(row.id, payload.note);
    }
  }
  return refs.map(id => { const note = found.get(id); if (!note) throw unavailable(); return note; });
}
