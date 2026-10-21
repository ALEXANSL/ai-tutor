import "server-only";
import { z } from "zod";

/**
 * S45 ($0 "Українська література" chapter-package v2.0.0 importer,
 * PO self-prepared package 2026-10-14, E-31/US-31.1…31.3, ADR-044) — pure
 * parsing/validation of the real `ukrlit-tutor-package` contract
 * (`schema/INTEGRATION.md`, read in full before writing this file; a
 * trimmed, REAL copy of every file's shape lives in
 * `__fixtures__/literature-course-v3/`, same convention as
 * `mathCourseV2Import.test.ts`/`literatureV2Import.test.ts`). ZERO AI calls
 * anywhere in this file — every lesson/screen/reading/biography/quiz text is
 * already finished, human-prepared content; this is schema validation only.
 *
 * Six JSON documents (not a zip of code to execute):
 *   - `package.json` — manifest: entrypoints, `progress_namespace`, audio flags.
 *   - `public/course.json` — `lessons[]` (with `flow[]`, the step order) and
 *     `tasks[]` (now `single_choice`, never a correct answer).
 *   - `public/readings.json` — **new file**: `works[]`/`items[]`/`biographies[]`
 *     — the actual text of the 37 works this package adds over `literature_v2_*`.
 *   - `private/teacher.json` — `items[]` (quiz answer keys, per-option
 *     feedback) + `lesson_guides[]`. Parsed here only so the import pipeline
 *     can persist the key half into `course_v2_question_keys` (never
 *     returned to a browser — see ADR-044 §1 for why that table, not a new one).
 *   - `catalog/assets.json` — **now an object** `{items}` (not a bare array,
 *     unlike `literatureV2Import.ts`'s `catalog/assets.json`): illustrations
 *     AND `lesson_pdf` (46 small per-lesson PDFs, each with its own `page_map`).
 *   - `catalog/pages.json` — **now an object** `{items}`: reverse page index
 *     (page → lesson/asset), the basis of the future "virtual book" reader.
 *   - `catalog/task_tables.json` — **always empty** `items` in this package
 *     version ("письмові таблиці замінено квізами") — validated, then
 *     ignored; no table is created for it (ADR-044 §1).
 *
 * Like `mathCourseV2Import.ts`/`literatureV2Import.ts`, a required field
 * missing is a real defect in the package, not something to paper over — the
 * affected row is skipped and reported (file + field + message), never
 * silently dropped nor thrown.
 */

export interface ImportIssue {
  file: string;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const zTts = z.object({ text: z.string(), lang: z.string() });
/** `{display, tts}` — the package's universal "narratable text" shape, used
 * for screen/reading/biography/task/explanation/hint content alike. */
const zContent = z.object({ display: z.string(), tts: zTts });

const FLOW_KINDS = ["screen", "biography", "reading", "quiz"] as const;
const zFlowItem = z.object({ kind: z.enum(FLOW_KINDS), ref_id: z.string().min(1) });

const zScreen = z.object({
  id: z.string().min(1),
  step_type: z.string().default(""),
  title: z.string().default(""),
  content: zContent,
  tutor_action: z.string().default(""),
  asset_ids: z.array(z.string()).default([]),
  source_page_ids: z.array(z.string()).default([]),
  origin: z.string().default(""),
});

const zTaskOption = z.object({ id: z.string().min(1), content: zContent });

const zTask = z.object({
  id: z.string().min(1),
  lesson_id: z.string().min(1),
  source_kind: z.string().default(""),
  prompt: zContent,
  response_type: z.literal("single_choice"),
  options: z.array(zTaskOption).min(2),
  shuffle_options: z.boolean().default(true),
  source_page_ids: z.array(z.string()).default([]),
  asset_refs: z.array(z.string()).default([]),
  required_inputs: z.array(z.unknown()).default([]),
  auto_grade: z.boolean().default(true),
  max_selections: z.number().int().default(1),
});

const zLesson = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  language: z.string().default("uk-UA"),
  grade: z.number().int(),
  source_pages: z.array(z.string()).default([]),
  estimated_minutes: z.number().int().optional().default(0),
  objectives: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  // Compatible-but-unused (ADR-044 §3 / INTEGRATION.md: "їхній матеріал уже
  // представлено в екранах" — kept only so the importer doesn't choke on
  // them, NEVER rendered by LiteratureV3LessonView).
  explanation: z.array(z.unknown()).default([]),
  definitions: z.array(z.unknown()).default([]),
  worked_example: z.unknown().nullable().optional().default(null),
  screens: z.array(zScreen).default([]),
  practice_task_ids: z.array(z.string()).default([]),
  final_check_task_ids: z.array(z.string()).default([]),
  task_ids: z.array(z.string()).default([]),
  misconceptions: z.array(z.string()).default([]),
  content_status: z.string().default(""),
  primary_reading_pages: z.array(z.string()).default([]),
  illustration_ids: z.array(z.string()).default([]),
  page_bundle_asset_id: z.string().nullable().default(null),
  reading_ids: z.array(z.string()).default([]),
  biography_ids: z.array(z.string()).default([]),
  flow: z.array(zFlowItem).min(1),
  // Loosely-typed metadata, not consumed by the viewer today — kept so a
  // future "скільки хвилин лишилось" estimate has everything without a re-import.
  playback: z.record(z.string(), z.unknown()).optional().default({}),
  duration: z.record(z.string(), z.unknown()).optional().default({}),
  narration_text_path: z.string().optional().default(""),
});

const zCourseTop = z.object({
  schema_version: z.string(),
  book_id: z.string().min(1),
  language: z.string().default("uk-UA"),
  grade: z.number().int(),
  lessons: z.array(zLesson),
  tasks: z.array(zTask),
});

const zWork = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  author: z.string().default(""),
  form: z.string().default(""),
  scope: z.string().default(""),
  completeness: z.string().default(""),
  reading_ids: z.array(z.string()).default([]),
  source_page_ids: z.array(z.string()).default([]),
  note: z.string().default(""),
});

const zReadingItem = z.object({
  id: z.string().min(1),
  work_id: z.string().min(1),
  sequence: z.number().int(),
  title: z.string().default(""),
  content_type: z.string().default(""),
  primary_page_id: z.string().nullable().default(null),
  source_page_ids: z.array(z.string()).default([]),
  content: zContent,
  text_asset_path: z.string().optional().default(""),
  estimated_audio_seconds: z.number().optional().default(0),
});

const zBiography = z.object({
  id: z.string().min(1),
  author_name: z.string().min(1),
  source_page_ids: z.array(z.string()).default([]),
  origin: z.string().default(""),
  content: zContent,
});

const zReadingsTop = z.object({
  schema_version: z.string(),
  book_id: z.string().min(1),
  works: z.array(zWork),
  items: z.array(zReadingItem),
  biographies: z.array(zBiography),
});

const zOptionFeedback = z.object({ option_id: z.string().min(1), is_correct: z.boolean(), content: zContent });

const zTaskKey = z.object({
  task_id: z.string().min(1),
  correct_option_ids: z.array(z.string().min(1)).min(1),
  answer: zContent.optional(),
  explanation: zContent,
  option_feedback: z.array(zOptionFeedback).default([]),
  hints: z.array(zContent).default([]),
  grading: z
    .object({ method: z.string().default(""), points: z.number().int().default(1), retry_allowed: z.boolean().default(true) })
    .optional()
    .default({ method: "", points: 1, retry_allowed: true }),
  review_reading_ids: z.array(z.string()).default([]),
});

const zLessonGuide = z.object({
  lesson_id: z.string().min(1),
  delivery_mode: z.string().default(""),
  full_script_source: z.record(z.string(), z.unknown()).optional().default({}),
  teaching_notes: zContent.optional(),
  specific_misconceptions: z.array(z.string()).default([]),
  discussion_optional: zContent.optional(),
  original_open_task_commentary: z.unknown().optional(),
});

const ASSET_KINDS = ["textbook_illustration", "lesson_pdf"] as const;

const zPageMapEntry = z.object({
  page_id: z.string().min(1),
  printed_page: z.number().int().min(1),
  source_pdf_page: z.number().int().min(1),
  bundle_pdf_page: z.number().int().min(1),
});

const zAsset = z.object({
  id: z.string().min(1),
  // Geography uses the same illustration contract for supplementary workbook figures.
  // Normalize to the existing image category; no database schema change is needed.
  kind: z.union([z.enum(ASSET_KINDS), z.literal("workbook_illustration")]).transform(kind => kind === "workbook_illustration" ? "textbook_illustration" as const : kind),
  path: z.string().min(1),
  mime_type: z.string().min(1),
  byte_size: z.number().int().optional().default(0),
  sha256: z.string().optional().default(""),
  page_id: z.string().nullish(),
  caption: z.string().optional().default(""),
  alt: z.string().optional().default(""),
  tts: zTts.optional(),
  title: z.string().optional().default(""),
  page_map: z.array(zPageMapEntry).optional().default([]),
});

const zPageLocation = z.object({ lesson_id: z.string().min(1), pdf_asset_id: z.string().min(1), bundle_pdf_page: z.number().int().min(1) });

const zPage = z.object({
  id: z.string().min(1),
  printed_page: z.number().int().min(1),
  source_pdf_page: z.number().int().min(1),
  transcript_path: z.string().optional().default(""),
  transcript_role: z.string().optional().default(""),
  lesson_locations: z.array(zPageLocation).default([]),
});

const zTaskTablesTop = z.object({ schema_version: z.string(), book_id: z.string().min(1), items: z.array(z.unknown()) });

// Accepted manifest formats for this "chapter package" contract family
// (ADR-044 §1): the content model — lesson.flow of screen/reading/
// biography/quiz steps, works/readings/biographies, single_choice quizzes
// reusing course_v2_questions, lesson_pdf + pages.json "virtual book" index
// — is identical across subjects; only the manifest's own `format` string
// and `book_id` differ per book. Hit THREE TIMES in one session (2026-10-16):
// `ukrlit-tutor-package` ("Українська література", S45) → `ukrmova-tutor-package`
// ("Українська мова", 2.0.1) → `history-tutor-package` ("Історія", 2.1.0) —
// each new subject's own ChatGPT-prepared package names its manifest format
// after ITS subject, and each schema bump so far has been purely additive
// (new, free-form enum values on `Work.scope`/`Work.completeness`, never a
// structural change to flow/readings/assets/pages). An exact-literal
// allowlist (`z.enum([...])`) meant hand-adding one more literal, and
// hitting this exact same import failure, every single time a NEW subject's
// package showed up — so this validates the established NAMING PATTERN
// (`<subject-prefix>-tutor-package`) instead of an exact, ever-growing list.
// Still rejects garbage (an empty string, a typo, an unrelated manifest
// shape) — just no longer a hotfix-the-literal treadmill for a shape that
// hasn't actually changed. Naming debt (not revisited here, same tradeoff
// ADR-043 already accepted for reuse over a new parallel system): the DB
// tables/components stay named `literature_v3_*` even though they now hold
// several non-literature subjects too.
const zPackageManifest = z.object({
  format: z.string().regex(/^[a-z]+-tutor-package$/, 'має бути "<предмет>-tutor-package" (напр. "ukrlit-tutor-package")'),
  schema_version: z.string(),
  book_id: z.string().min(1),
  progress_namespace: z.string().min(1),
  source_edition: z.string().optional().default(""),
});

export type ParsedLesson = z.infer<typeof zLesson>;
export type ParsedScreen = z.infer<typeof zScreen>;
export type ParsedTask = z.infer<typeof zTask>;
export type ParsedWork = z.infer<typeof zWork>;
export type ParsedReadingItem = z.infer<typeof zReadingItem>;
export type ParsedBiography = z.infer<typeof zBiography>;
export type ParsedTaskKey = z.infer<typeof zTaskKey>;
export type ParsedLessonGuide = z.infer<typeof zLessonGuide>;
export type ParsedAsset = z.infer<typeof zAsset>;
export type ParsedPage = z.infer<typeof zPage>;
export type ParsedPackageManifest = z.infer<typeof zPackageManifest>;

/** Parses one array field with a zod item schema; invalid items are skipped and reported, never silently dropped nor thrown. */
function parseArray<T extends z.ZodTypeAny>(raw: unknown, schema: T, file: string, listField: string, errors: ImportIssue[]): z.infer<T>[] {
  if (!Array.isArray(raw)) {
    errors.push({ file, field: listField, message: `очікувався масив, отримано ${typeof raw}` });
    return [];
  }
  const out: z.infer<T>[] = [];
  raw.forEach((item, i) => {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
    else {
      const id = typeof (item as Record<string, unknown>)?.id === "string" ? (item as Record<string, unknown>).id : `[${i}]`;
      errors.push({ file, field: `${listField}.${id}`, message: result.error.issues.map((iss) => `${iss.path.join(".")}: ${iss.message}`).join("; ") });
    }
  });
  return out;
}

export function parseLiteratureV3PackageManifest(raw: unknown): { manifest: ParsedPackageManifest | null; errors: ImportIssue[] } {
  const file = "package.json";
  const result = zPackageManifest.safeParse(raw);
  if (!result.success) return { manifest: null, errors: [{ file, field: "$", message: `не відповідає контракту: ${result.error.issues.map((i) => i.message).join("; ")}` }] };
  return { manifest: result.data, errors: [] };
}

export interface ParsedCourse {
  bookId: string | null;
  lessons: ParsedLesson[];
  tasks: ParsedTask[];
  errors: ImportIssue[];
}

export function parseLiteratureV3Course(raw: unknown): ParsedCourse {
  const errors: ImportIssue[] = [];
  const file = "public/course.json";
  const top = zCourseTop.safeParse(raw);
  if (!top.success) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.error.issues.map((i) => i.message).join("; ")}` });
    return { bookId: null, lessons: [], tasks: [], errors };
  }
  // zCourseTop already validates lessons/tasks strictly — re-parse via
  // parseArray only to get the per-item skip-and-report behaviour on a
  // partially-invalid file rather than failing the whole document.
  const obj = raw as Record<string, unknown>;
  const lessons = parseArray(obj.lessons, zLesson, file, "lessons", errors);
  const tasks = parseArray(obj.tasks, zTask, file, "tasks", errors);
  return { bookId: top.data.book_id, lessons, tasks, errors };
}

export interface ParsedReadings {
  bookId: string | null;
  works: ParsedWork[];
  items: ParsedReadingItem[];
  biographies: ParsedBiography[];
  errors: ImportIssue[];
}

export function parseLiteratureV3Readings(raw: unknown): ParsedReadings {
  const errors: ImportIssue[] = [];
  const file = "public/readings.json";
  const top = zReadingsTop.safeParse(raw);
  const bookId = typeof (raw as Record<string, unknown>)?.book_id === "string" ? ((raw as Record<string, unknown>).book_id as string) : null;
  if (!top.success && !Array.isArray((raw as Record<string, unknown>)?.works)) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.success ? "" : top.error.issues.map((i) => i.message).join("; ")}` });
    return { bookId, works: [], items: [], biographies: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  return {
    bookId,
    works: parseArray(obj.works, zWork, file, "works", errors),
    items: parseArray(obj.items, zReadingItem, file, "items", errors),
    biographies: parseArray(obj.biographies, zBiography, file, "biographies", errors),
    errors,
  };
}

export interface ParsedTeacher {
  bookId: string | null;
  taskKeys: ParsedTaskKey[];
  lessonGuides: ParsedLessonGuide[];
  errors: ImportIssue[];
}

export function parseLiteratureV3Teacher(raw: unknown): ParsedTeacher {
  const errors: ImportIssue[] = [];
  const file = "private/teacher.json";
  const bookId = typeof (raw as Record<string, unknown>)?.book_id === "string" ? ((raw as Record<string, unknown>).book_id as string) : null;
  if (!Array.isArray((raw as Record<string, unknown>)?.items)) {
    errors.push({ file, field: "items", message: "очікувався масив" });
    return { bookId, taskKeys: [], lessonGuides: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  return {
    bookId,
    taskKeys: parseArray(obj.items, zTaskKey, file, "items", errors),
    lessonGuides: parseArray(obj.lesson_guides, zLessonGuide, file, "lesson_guides", errors),
    errors,
  };
}

export interface ParsedAssets {
  bookId: string | null;
  assets: ParsedAsset[];
  errors: ImportIssue[];
}

/** `catalog/assets.json` is now an OBJECT `{items}` (ADR-044 §1) — unlike
 * `literatureV2Import.ts`'s `parseLiteratureV2Assets`, which reads a bare
 * array. Reading `.items` here, never the top-level value itself. */
export function parseLiteratureV3Assets(raw: unknown): ParsedAssets {
  const errors: ImportIssue[] = [];
  const file = "catalog/assets.json";
  const bookId = typeof (raw as Record<string, unknown>)?.book_id === "string" ? ((raw as Record<string, unknown>).book_id as string) : null;
  if (Array.isArray(raw)) {
    errors.push({ file, field: "$", message: "очікувався об'єкт {items}, отримано масив — це старий (literature_v2) контракт, не v3" });
    return { bookId, assets: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj?.items)) {
    errors.push({ file, field: "items", message: "очікувався масив" });
    return { bookId, assets: [], errors };
  }
  const assets = parseArray(obj.items, zAsset, file, "items", errors);
  for (const a of assets) {
    if (a.kind === "lesson_pdf") {
      for (const pm of a.page_map) {
        if (pm.printed_page < 1 || pm.source_pdf_page < 1 || pm.bundle_pdf_page < 1) {
          errors.push({ file, field: `items.${a.id}.page_map`, message: "номери сторінок мають починатися з 1" });
        }
      }
    }
  }
  return { bookId, assets, errors };
}

export interface ParsedPages {
  bookId: string | null;
  pages: ParsedPage[];
  errors: ImportIssue[];
}

export function parseLiteratureV3Pages(raw: unknown): ParsedPages {
  const errors: ImportIssue[] = [];
  const file = "catalog/pages.json";
  const bookId = typeof (raw as Record<string, unknown>)?.book_id === "string" ? ((raw as Record<string, unknown>).book_id as string) : null;
  if (Array.isArray(raw)) {
    errors.push({ file, field: "$", message: "очікувався об'єкт {items}, отримано масив" });
    return { bookId, pages: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj?.items)) {
    errors.push({ file, field: "items", message: "очікувався масив" });
    return { bookId, pages: [], errors };
  }
  return { bookId, pages: parseArray(obj.items, zPage, file, "items", errors), errors };
}

/**
 * `catalog/task_tables.json` — validated, then IGNORED (ADR-044 §1: "у
 * версії 2.0 обов'язкові письмові таблиці замінено квізами" — `items` is
 * always empty by the package's own contract). A non-empty `items` is a
 * WARNING (forward-compatibility signal), never fatal — nothing is persisted
 * either way, no `literature_v3_task_tables` table exists.
 */
export function parseLiteratureV3TaskTables(raw: unknown): { warnings: ImportIssue[]; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const file = "catalog/task_tables.json";
  const top = zTaskTablesTop.safeParse(raw);
  if (!top.success) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.error.issues.map((i) => i.message).join("; ")}` });
    return { warnings, errors };
  }
  if (top.data.items.length > 0) {
    warnings.push({ file, field: "items", message: `очікувався порожній масив у цій версії пакета, отримано ${top.data.items.length} — ігноровано` });
  }
  return { warnings, errors };
}

export interface ParsedLiteratureV3Package {
  manifest: ParsedPackageManifest | null;
  lessons: ParsedLesson[];
  tasks: ParsedTask[];
  works: ParsedWork[];
  readingItems: ParsedReadingItem[];
  biographies: ParsedBiography[];
  taskKeys: ParsedTaskKey[];
  lessonGuides: ParsedLessonGuide[];
  assets: ParsedAsset[];
  pages: ParsedPage[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

/**
 * Combines all six already-parsed documents, cross-checks referential
 * integrity (US-31.1 КП-4: "узгодженість flow[].ref_id із реальними
 * screens/biographies/items/tasks, узгодженість correct_option_ids з
 * options[].id") and returns one package ready for `literatureV3Persist.ts`.
 * Mismatches are WARNINGS (skip the affected row), never fatal — same
 * resilience contract as `mathCourseV2Import.ts`'s `combineMathCourseV2Package`.
 */
export function combineLiteratureV3Package(
  manifest: { manifest: ParsedPackageManifest | null; errors: ImportIssue[] },
  course: ParsedCourse,
  readings: ParsedReadings,
  teacher: ParsedTeacher,
  assets: ParsedAssets,
  pages: ParsedPages,
  taskTables: { warnings: ImportIssue[]; errors: ImportIssue[] },
): ParsedLiteratureV3Package {
  const warnings: ImportIssue[] = [...taskTables.warnings];

  const screenIds = new Set(course.lessons.flatMap((l) => l.screens.map((s) => s.id)));
  const readingItemIds = new Set(readings.items.map((r) => r.id));
  const biographyIds = new Set(readings.biographies.map((b) => b.id));
  const taskIds = new Set(course.tasks.map((t) => t.id));

  const refSetByKind: Record<(typeof FLOW_KINDS)[number], Set<string>> = {
    screen: screenIds,
    reading: readingItemIds,
    biography: biographyIds,
    quiz: taskIds,
  };

  for (const lesson of course.lessons) {
    for (const step of lesson.flow) {
      if (!refSetByKind[step.kind].has(step.ref_id)) {
        warnings.push({ file: "public/course.json", field: `lessons.${lesson.id}.flow`, message: `${step.kind} "${step.ref_id}" не знайдено — крок буде пропущено під час показу` });
      }
    }
  }

  const optionIdsByTask = new Map(course.tasks.map((t) => [t.id, new Set(t.options.map((o) => o.id))]));
  const taskKeys = teacher.taskKeys.filter((k) => {
    const optionIds = optionIdsByTask.get(k.task_id);
    if (!optionIds) {
      warnings.push({ file: "private/teacher.json", field: `items.${k.task_id}`, message: `task_id "${k.task_id}" не знайдено серед public.tasks — ключ пропущено` });
      return false;
    }
    const badOptionIds = k.correct_option_ids.filter((id) => !optionIds.has(id));
    if (badOptionIds.length > 0) {
      warnings.push({ file: "private/teacher.json", field: `items.${k.task_id}.correct_option_ids`, message: `ідентифікатор(и) ${badOptionIds.join(", ")} відсутні серед options — ключ пропущено` });
      return false;
    }
    return true;
  });
  const keyedTaskIds = new Set(taskKeys.map((k) => k.task_id));
  for (const t of course.tasks) {
    if (!keyedTaskIds.has(t.id)) warnings.push({ file: "private/teacher.json", field: "items", message: `завдання "${t.id}" не має приватного ключа — квіз не зможе перевірити відповідь` });
  }

  return {
    manifest: manifest.manifest,
    lessons: course.lessons,
    tasks: course.tasks,
    works: readings.works,
    readingItems: readings.items,
    biographies: readings.biographies,
    taskKeys,
    lessonGuides: teacher.lessonGuides,
    assets: assets.assets,
    pages: pages.pages,
    errors: [...manifest.errors, ...course.errors, ...readings.errors, ...teacher.errors, ...assets.errors, ...pages.errors, ...taskTables.errors],
    warnings,
  };
}
