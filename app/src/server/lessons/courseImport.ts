import "server-only";
import { strFromU8, unzipSync } from "fflate";

/**
 * S34 ($0 course-package importer, PO decision 2026-10-02 — see
 * `supabase/migrations/20261016100000_s34_course_import.sql`'s header for
 * the full context). Pure parsing/validation of the PO's own
 * image-anchored package format — NO AI CALL ANYWHERE IN THIS FILE, and
 * deliberately NOTHING is invented/guessed when a required field is
 * missing: unlike `literatureImport.ts` (S33, which fills a clearly-labelled
 * Ukrainian placeholder for a missing field, because that format's author
 * is a chat assistant prone to dropping a section), this package's schema
 * (`__fixtures__/ister-math6-part1/schema/*.schema.json`) is the package
 * author's own strict contract — a required field missing is a REAL defect
 * in the package, not something we should paper over, so the affected
 * lesson/test/exercise/block is skipped and reported with the exact file
 * and field (PO: "не повторювати мовчазні провали").
 *
 * No new dependency: `fflate` (already used by `literatureImport.ts`) for
 * the zip; a lightweight hand-rolled required-field check against the
 * package's own `schema/*.schema.json` contract (no `ajv`/JSON-Schema
 * library in `package.json` — adding one just for this would be more
 * surface than four small, stable object shapes need).
 */

export interface ImportIssue {
  /** Zip-relative path of the file the issue concerns (e.g. "lessons/p01.json"), or null for a package-level problem. */
  file: string | null;
  field: string;
  message: string;
}

export interface ParsedSourceImageBlock {
  type: "source_image";
  assetId: string | null;
  path: string;
  source: { printedPage: number | null; pdfPage: number | null; bboxPt: number[] | null };
  pageImagePath: string | null;
  searchTextOcr: string | null;
  textStatus: string | null;
  authoritativeRepresentation: string | null;
}

export interface ParsedLessonSource {
  paragraph: number | null;
  printedPages: number[];
  pdfPages: number[];
  start: unknown;
  endExclusive: unknown;
}

export interface ParsedLesson {
  lessonKey: string;
  order: number;
  kind: "lesson" | "review" | "assessment";
  title: string;
  grade: number | null;
  part: number | null;
  source: ParsedLessonSource;
  teacherNotesMd: string;
  teacherNotesOrigin: string | null;
  sourceMaterial: ParsedSourceImageBlock[];
  exerciseIds: string[];
  exerciseCount: number;
  testPath: string;
  fullPageImagePaths: string[];
  sourceTextPolicy: string | null;
  /** true when at least one non-fatal issue was found inside this lesson (a malformed source_material block, a missing test file, …) — the persisted row is marked `needs_review`. */
  needsReview: boolean;
}

export interface ParsedAutomaticQuestion {
  id: string;
  type: "single_choice";
  origin: string | null;
  promptMd: string;
  options: { id: string; textMd: string }[];
  correctOptionId: string;
  explanationMd: string;
  maxPoints: number;
}

export interface ParsedTest {
  testKey: string;
  lessonKey: string;
  title: string;
  automaticQuestions: ParsedAutomaticQuestion[];
  automaticMaxPoints: number;
  sourceExerciseIds: string[];
  sourceKeysResource: string | null;
  gradingPolicy: string | null;
}

export interface ParsedExercise {
  exerciseKey: string;
  lessonKey: string;
  origin: string;
  originalNumber: string;
  source: ParsedLessonSource;
  content: ParsedSourceImageBlock[];
  figureIds: string[];
  figurePaths: string[];
  searchTextOcr: string | null;
  textStatus: string | null;
  responseType: string;
  grading: { mode: string; answerKey: null };
  measurementWarning: boolean;
}

export interface ParsedAssetIndexEntry {
  id: string;
  path: string;
  mimeType: string;
  alt: string | null;
  printedPage: number | null;
  pdfPage: number | null;
  bboxPt: number[] | null;
  widthPx: number | null;
  heightPx: number | null;
  physicalWidthMm: number | null;
  physicalHeightMm: number | null;
  scalePxPerPdfPoint: number | null;
}

export interface ParsedManifest {
  id: string;
  title: string;
  language: string;
  schemaVersion: string;
  sourceFile: string | null;
  sourceSha256: string | null;
  grade: number | null;
  part: number | null;
  counts: Record<string, unknown>;
  qualityNotes: string[];
  lessonFiles: string[];
  testFiles: string[];
}

export interface ParsedCoursePackage {
  manifest: ParsedManifest | null;
  lessons: ParsedLesson[];
  testsByLessonKey: Map<string, ParsedTest>;
  exercises: ParsedExercise[];
  /** From `assets/index.json` when the package includes it — optional, physical-scale metadata only (brief: "persist it if cheap, don't block on it"). */
  assetIndex: Map<string, ParsedAssetIndexEntry>;
  /** Every file found under `assets/` in the zip, keyed by its zip-relative path, raw bytes — only the ones actually referenced by a lesson/exercise get uploaded (see `coursePersist.ts`). */
  assetFiles: Map<string, Uint8Array>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

function u8(entries: Record<string, Uint8Array>, path: string): Uint8Array | null {
  const normalized = path.replace(/^\.?\//, "");
  return entries[normalized] ?? entries[`./${normalized}`] ?? null;
}

function readJson(entries: Record<string, Uint8Array>, path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const bytes = u8(entries, path);
  if (!bytes) return { ok: false, reason: "файл відсутній у архіві" };
  try {
    return { ok: true, value: JSON.parse(strFromU8(bytes)) };
  } catch (e) {
    return { ok: false, reason: `не вдалося розібрати JSON (${(e as Error).message})` };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

/** One `source_image` content block — required: type, path, source{printed_page,pdf_page,bbox_pt}, text_status, authoritative_representation. */
function parseSourceImageBlock(raw: unknown, file: string, index: number, listField: string, warn: (field: string, message: string) => void): ParsedSourceImageBlock | null {
  if (!isRecord(raw)) {
    warn(`${listField}[${index}]`, "елемент не є об'єктом — пропущено");
    return null;
  }
  if (raw.type !== "source_image") {
    warn(`${listField}[${index}].type`, `очікувався "source_image", отримано ${JSON.stringify(raw.type)} — пропущено`);
    return null;
  }
  const path = str(raw.path);
  if (!path) {
    warn(`${listField}[${index}].path`, "відсутній шлях до зображення — пропущено");
    return null;
  }
  const source = isRecord(raw.source) ? raw.source : null;
  const bboxRaw = source ? source.bbox_pt : null;
  const bboxPt = Array.isArray(bboxRaw) && bboxRaw.length === 4 ? numArray(bboxRaw) : null;
  if (!source || num(source.printed_page) == null || num(source.pdf_page) == null || !bboxPt) {
    warn(`${listField}[${index}].source`, "відсутні координати джерела (printed_page/pdf_page/bbox_pt) — пропущено");
    return null;
  }
  const textStatus = str(raw.text_status);
  const authoritativeRepresentation = str(raw.authoritative_representation);
  if (textStatus !== "unverified_ocr" || authoritativeRepresentation !== "image") {
    warn(`${listField}[${index}]`, "text_status/authoritative_representation не відповідають очікуваним значенням — пропущено");
    return null;
  }
  return {
    type: "source_image",
    assetId: str(raw.asset_id),
    path,
    source: { printedPage: num(source.printed_page), pdfPage: num(source.pdf_page), bboxPt },
    pageImagePath: str(raw.page_image_path),
    searchTextOcr: str(raw.search_text_ocr),
    textStatus,
    authoritativeRepresentation,
  };
}

function parseLessonSource(raw: unknown): ParsedLessonSource | null {
  if (!isRecord(raw)) return null;
  const printedPages = numArray(raw.printed_pages);
  const pdfPages = numArray(raw.pdf_pages);
  if (printedPages.length === 0 || pdfPages.length === 0) return null;
  return { paragraph: num(raw.paragraph), printedPages, pdfPages, start: raw.start ?? null, endExclusive: raw.end_exclusive ?? null };
}

const LESSON_KINDS = new Set(["lesson", "review", "assessment"]);

/** `lessons/*.json` — required: schema_version, id, order, kind, title, source, teacher_notes_md, source_material, exercise_ids, test_path (schema/lesson.schema.json). */
export function parseCourseLesson(raw: unknown, file: string, errors: ImportIssue[], warnings: ImportIssue[]): ParsedLesson | null {
  const err = (field: string, message: string) => errors.push({ file, field, message });
  const warn = (field: string, message: string) => warnings.push({ file, field, message });

  if (!isRecord(raw)) {
    err("$", "файл уроку не є JSON-об'єктом");
    return null;
  }
  const lessonKey = str(raw.id);
  if (!lessonKey) {
    err("id", "відсутній ідентифікатор уроку (id)");
    return null;
  }
  const order = num(raw.order);
  if (order == null) {
    err("order", "відсутній порядковий номер (order)");
    return null;
  }
  const kind = str(raw.kind);
  if (!kind || !LESSON_KINDS.has(kind)) {
    err("kind", `невідомий тип (kind): ${JSON.stringify(raw.kind)} — очікувалось lesson/review/assessment`);
    return null;
  }
  const title = str(raw.title);
  if (!title) {
    err("title", "відсутня назва (title)");
    return null;
  }
  const source = parseLessonSource(raw.source);
  if (!source) {
    err("source", "відсутні printed_pages/pdf_pages у джерелі (source)");
    return null;
  }
  const teacherNotesMd = str(raw.teacher_notes_md);
  if (teacherNotesMd == null) {
    err("teacher_notes_md", "відсутній текст короткого пояснення (teacher_notes_md)");
    return null;
  }
  if (!Array.isArray(raw.source_material)) {
    err("source_material", "відсутній масив джерельного матеріалу (source_material)");
    return null;
  }
  let needsReview = false;
  const sourceMaterial: ParsedSourceImageBlock[] = [];
  raw.source_material.forEach((block, i) => {
    const parsed = parseSourceImageBlock(block, file, i, "source_material", (f, m) => {
      warn(f, m);
      needsReview = true;
    });
    if (parsed) sourceMaterial.push(parsed);
  });
  if (sourceMaterial.length === 0) {
    err("source_material", "жодного придатного фрагмента джерельного матеріалу — урок без теорії підручника не імпортується");
    return null;
  }
  const exerciseIds = strArray(raw.exercise_ids);
  const testPath = str(raw.test_path);
  if (!testPath) {
    err("test_path", "відсутній шлях до тесту (test_path)");
    return null;
  }

  return {
    lessonKey,
    order,
    kind: kind as ParsedLesson["kind"],
    title,
    grade: num(raw.grade),
    part: num(raw.part),
    source,
    teacherNotesMd,
    teacherNotesOrigin: str(raw.teacher_notes_origin),
    sourceMaterial,
    exerciseIds,
    exerciseCount: num(raw.exercise_count) ?? exerciseIds.length,
    testPath,
    fullPageImagePaths: strArray(raw.full_page_image_paths),
    sourceTextPolicy: str(raw.source_text_policy),
    needsReview,
  };
}

/** `tests/*.json` — required: schema_version, id, lesson_id, title, automatic_questions, source_exercise_ids, automatic_max_points (schema/test.schema.json). */
export function parseCourseTest(raw: unknown, file: string, errors: ImportIssue[], warnings: ImportIssue[]): ParsedTest | null {
  const err = (field: string, message: string) => errors.push({ file, field, message });
  const warn = (field: string, message: string) => warnings.push({ file, field, message });

  if (!isRecord(raw)) {
    err("$", "файл тесту не є JSON-об'єктом");
    return null;
  }
  const testKey = str(raw.id);
  const lessonKey = str(raw.lesson_id);
  if (!testKey || !lessonKey) {
    err("id/lesson_id", "відсутній ідентифікатор тесту або уроку, до якого він належить");
    return null;
  }
  const title = str(raw.title) ?? "";
  if (!Array.isArray(raw.automatic_questions)) {
    err("automatic_questions", "відсутній масив автоматичних питань");
    return null;
  }
  const automaticQuestions: ParsedAutomaticQuestion[] = [];
  raw.automatic_questions.forEach((q, i) => {
    if (!isRecord(q)) {
      warn(`automatic_questions[${i}]`, "питання не є об'єктом — пропущено");
      return;
    }
    const id = str(q.id);
    const promptMd = str(q.prompt_md);
    const correctOptionId = str(q.correct_option_id);
    const explanationMd = str(q.explanation_md);
    const optionsRaw = Array.isArray(q.options) ? q.options : [];
    const options = optionsRaw
      .map((o) => (isRecord(o) && str(o.id) && str(o.text_md) ? { id: str(o.id) as string, textMd: str(o.text_md) as string } : null))
      .filter((o): o is { id: string; textMd: string } => o != null);
    if (!id || q.type !== "single_choice" || !promptMd || options.length !== 4 || !correctOptionId || !explanationMd) {
      warn(`automatic_questions[${i}]`, "питання не відповідає схемі (id/type/prompt_md/4 варіанти/correct_option_id/explanation_md) — пропущено");
      return;
    }
    if (!options.some((o) => o.id === correctOptionId)) {
      warn(`automatic_questions[${i}].correct_option_id`, "правильний варіант не знайдено серед options — питання пропущено");
      return;
    }
    automaticQuestions.push({
      id,
      type: "single_choice",
      origin: str(q.origin),
      promptMd,
      options,
      correctOptionId,
      explanationMd,
      maxPoints: num(q.max_points) ?? 1,
    });
  });

  return {
    testKey,
    lessonKey,
    title,
    automaticQuestions,
    automaticMaxPoints: num(raw.automatic_max_points) ?? automaticQuestions.reduce((s, q) => s + q.maxPoints, 0),
    sourceExerciseIds: strArray(raw.source_exercise_ids),
    sourceKeysResource: str(raw.source_keys_resource),
    gradingPolicy: str(raw.grading_policy),
  };
}

/** One `exercises.jsonl` line — required: id, lesson_id, origin, original_number, source, content (>=1), figure_ids, grading (schema/exercise.schema.json). */
export function parseCourseExercise(raw: unknown, file: string, errors: ImportIssue[], warnings: ImportIssue[]): ParsedExercise | null {
  const err = (field: string, message: string) => errors.push({ file, field, message });
  const warn = (field: string, message: string) => warnings.push({ file, field, message });

  if (!isRecord(raw)) {
    err("$", "рядок вправи не є JSON-об'єктом");
    return null;
  }
  const exerciseKey = str(raw.id);
  const lessonKey = str(raw.lesson_id);
  const originalNumber = str(raw.original_number);
  if (!exerciseKey || !lessonKey || !originalNumber) {
    err("id/lesson_id/original_number", "відсутній ідентифікатор вправи, уроку або оригінальний номер");
    return null;
  }
  const source = parseLessonSource(raw.source);
  if (!source) {
    err("source", "відсутні printed_pages/pdf_pages у джерелі вправи");
    return null;
  }
  if (!Array.isArray(raw.content) || raw.content.length === 0) {
    err("content", "відсутній вміст вправи (content)");
    return null;
  }
  const content: ParsedSourceImageBlock[] = [];
  raw.content.forEach((block, i) => {
    const parsed = parseSourceImageBlock(block, file, i, "content", (f, m) => warn(`${exerciseKey}.${f}`, m));
    if (parsed) content.push(parsed);
  });
  if (content.length === 0) {
    err("content", "жодного придатного блоку зображення у вправі — пропущено");
    return null;
  }
  const gradingRaw = isRecord(raw.grading) ? raw.grading : null;

  return {
    exerciseKey,
    lessonKey,
    origin: str(raw.origin) ?? "textbook",
    originalNumber,
    source,
    content,
    figureIds: strArray(raw.figure_ids),
    figurePaths: strArray(raw.figure_paths),
    searchTextOcr: str(raw.search_text_ocr),
    textStatus: str(raw.text_status),
    responseType: str(raw.response_type) ?? "open_response",
    grading: { mode: (gradingRaw && str(gradingRaw.mode)) ?? "manual_or_tutor_review", answerKey: null },
    measurementWarning: raw.measurement_warning === true,
  };
}

/** `assets/index.json` (optional — brief: "persist it if cheap, don't block"). */
function parseAssetIndex(raw: unknown, warnings: ImportIssue[]): Map<string, ParsedAssetIndexEntry> {
  const map = new Map<string, ParsedAssetIndexEntry>();
  if (!Array.isArray(raw)) return map;
  raw.forEach((entry, i) => {
    if (!isRecord(entry)) return;
    const id = str(entry.id);
    const path = str(entry.path);
    if (!id || !path) {
      warnings.push({ file: "assets/index.json", field: `[${i}]`, message: "запис без id/path — пропущено" });
      return;
    }
    const source = isRecord(entry.source) ? entry.source : null;
    map.set(id, {
      id,
      path,
      mimeType: str(entry.mime_type) ?? "image/webp",
      alt: str(entry.alt),
      printedPage: source ? num(source.printed_page) : null,
      pdfPage: source ? num(source.pdf_page) : null,
      bboxPt: source && Array.isArray(source.bbox_pt) ? numArray(source.bbox_pt) : null,
      widthPx: num(entry.width_px),
      heightPx: num(entry.height_px),
      physicalWidthMm: num(entry.physical_width_mm),
      physicalHeightMm: num(entry.physical_height_mm),
      scalePxPerPdfPoint: num(entry.scale_pixels_per_pdf_point),
    });
  });
  return map;
}

function parseManifest(raw: unknown, errors: ImportIssue[]): ParsedManifest | null {
  const err = (field: string, message: string) => errors.push({ file: "manifest.json", field, message });
  if (!isRecord(raw)) {
    err("$", "manifest.json не є JSON-об'єктом");
    return null;
  }
  const id = str(raw.id);
  const title = str(raw.title);
  const lessonFiles = strArray(raw.lesson_files);
  if (!id || !title || lessonFiles.length === 0) {
    err("id/title/lesson_files", "відсутні обов'язкові поля пакета (id, title, lesson_files)");
    return null;
  }
  const counts = isRecord(raw.counts) ? raw.counts : {};
  return {
    id,
    title,
    language: str(raw.language) ?? "uk",
    schemaVersion: str(raw.schema_version) ?? "1.0.0",
    sourceFile: str(raw.source_file),
    sourceSha256: str(raw.source_sha256),
    grade: num((counts as Record<string, unknown>).grade) ?? null,
    part: null,
    counts,
    qualityNotes: strArray(raw.quality_notes),
    lessonFiles,
    testFiles: strArray(raw.test_files),
  };
}

/** Every zip entry whose path starts with `assets/` — kept as raw bytes, only uploaded later if actually referenced. */
function collectAssetFiles(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(entries)) {
    const normalized = key.replace(/^\.?\//, "");
    if (normalized.startsWith("assets/") && !normalized.endsWith("/")) map.set(normalized, bytes);
  }
  return map;
}

/**
 * Parses a whole course-package zip (pure/sync — no I/O beyond `unzipSync`
 * on already-read bytes, mirrors `literatureImport.ts`'s
 * `parseLiteratureCourseZip` — safe to unit-test directly against the real
 * fixtures, and safe to call from both the staged-upload import action and
 * a one-off CLI script).
 */
export function parseCoursePackageZip(zipBytes: Uint8Array): ParsedCoursePackage {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (e) {
    errors.push({ file: null, field: "zip", message: `не вдалося розпакувати архів (${(e as Error).message})` });
    return { manifest: null, lessons: [], testsByLessonKey: new Map(), exercises: [], assetIndex: new Map(), assetFiles: new Map(), errors, warnings };
  }

  const manifestResult = readJson(entries, "manifest.json");
  if (!manifestResult.ok) {
    errors.push({ file: "manifest.json", field: "$", message: manifestResult.reason });
    return { manifest: null, lessons: [], testsByLessonKey: new Map(), exercises: [], assetIndex: new Map(), assetFiles: new Map(), errors, warnings };
  }
  const manifest = parseManifest(manifestResult.value, errors);
  if (!manifest) {
    return { manifest: null, lessons: [], testsByLessonKey: new Map(), exercises: [], assetIndex: new Map(), assetFiles: new Map(), errors, warnings };
  }

  const lessons: ParsedLesson[] = [];
  for (const path of manifest.lessonFiles) {
    const result = readJson(entries, path);
    if (!result.ok) {
      errors.push({ file: path, field: "$", message: result.reason });
      continue;
    }
    const lesson = parseCourseLesson(result.value, path, errors, warnings);
    if (lesson) lessons.push(lesson);
  }

  const testsByLessonKey = new Map<string, ParsedTest>();
  for (const lesson of lessons) {
    const result = readJson(entries, lesson.testPath);
    if (!result.ok) {
      warnings.push({ file: lesson.testPath, field: "$", message: `тест для уроку "${lesson.lessonKey}" не знайдено — урок буде без тесту (${result.reason})` });
      lesson.needsReview = true;
      continue;
    }
    const test = parseCourseTest(result.value, lesson.testPath, errors, warnings);
    if (test) testsByLessonKey.set(lesson.lessonKey, test);
    else lesson.needsReview = true;
  }
  // Also parse any remaining manifest.test_files entries not already covered (lessons whose test_path pointed elsewhere, or orphan test files) — best-effort, non-fatal.
  for (const path of manifest.testFiles) {
    const result = readJson(entries, path);
    if (!result.ok) continue;
    const test = parseCourseTest(result.value, path, [], warnings);
    if (test && !testsByLessonKey.has(test.lessonKey)) testsByLessonKey.set(test.lessonKey, test);
  }

  const exercises: ParsedExercise[] = [];
  const exercisesJsonlPath = Object.keys(entries).find((k) => k.replace(/^\.?\//, "") === "exercises.jsonl" || k.replace(/^\.?\//, "") === "exercises.sample.jsonl");
  if (exercisesJsonlPath) {
    const text = strFromU8(entries[exercisesJsonlPath]!);
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    lines.forEach((line, i) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (e) {
        warnings.push({ file: exercisesJsonlPath, field: `line ${i + 1}`, message: `не вдалося розібрати JSON (${(e as Error).message})` });
        return;
      }
      const exercise = parseCourseExercise(value, `${exercisesJsonlPath}:${i + 1}`, errors, warnings);
      if (exercise) exercises.push(exercise);
    });
  } else {
    warnings.push({ file: null, field: "exercises.jsonl", message: "файл з оригінальними вправами відсутній у архіві — уроки імпортовано без довідкових вправ" });
  }

  const assetIndexResult = readJson(entries, "assets/index.json");
  const assetIndex = assetIndexResult.ok ? parseAssetIndex(assetIndexResult.value, warnings) : new Map<string, ParsedAssetIndexEntry>();

  const assetFiles = collectAssetFiles(entries);

  return { manifest, lessons, testsByLessonKey, exercises, assetIndex, assetFiles, errors, warnings };
}
