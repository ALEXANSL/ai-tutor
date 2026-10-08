import "server-only";
import { z } from "zod";

/**
 * S36 ($0 foreign-literature course-package v2 importer, PO upload
 * 2026-10-08) — pure parsing/validation of the "Зарубіжна література, 6
 * клас" (Літера ЛТД, 2023) package: `public/course.json` (lessons + open-
 * response tasks), `private/teacher.json` (per-task hints/model-answer/
 * criteria/misconceptions), `catalog/assets.json` (illustrations) and
 * `catalog/task_tables.json` (fill-in tables). ZERO AI calls — every field
 * is already finished, human-written content; this is schema validation
 * only, same spirit as `mathCourseV2Import.ts`.
 *
 * Every task's `auto_grade` is `false` by this package's own contract
 * (§7: "Для всіх завдань auto_grade=false") — there is no correct option to
 * hide, only a model answer, grading criteria and misconception guidance,
 * which is exactly why this gets its own schema instead of reusing S35's
 * math course_v2 one (see migration header for the full reasoning).
 *
 * The common "display text + TTS (possibly multi-language segments)"
 * shape repeats everywhere in this package (explanations, definitions,
 * screens, task prompts, hints, model answers, misconception feedback) —
 * factored into `zRichText` below instead of being redeclared each time.
 */

export interface ImportIssue {
  file: string;
  field: string;
  message: string;
}

const zTtsSegment = z.object({ text: z.string(), lang: z.string() });
const zTts = z.object({
  text: z.string(),
  lang: z.string().default("uk-UA"),
  segments: z.array(zTtsSegment).optional(),
});
const zRichText = z.object({ display: z.string(), tts: zTts });

const zSubtask = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  prompt: zRichText,
});

const zTaskSource = z.object({
  printed_page: z.number().int().nullable().default(null),
  pdf_page: z.number().int().nullable().default(null),
  page_id: z.string().default(""),
  rubric: z.string().default(""),
});

const zTask = z.object({
  id: z.string().min(1),
  lesson_id: z.string().min(1),
  source_kind: z.string().default("textbook"),
  original_label: z.string().default(""),
  prompt: zRichText,
  subtasks: z.array(zSubtask).default([]),
  response_type: z.string().default("open"),
  source: zTaskSource.default({ printed_page: null, pdf_page: null, page_id: "", rubric: "" }),
  asset_refs: z.array(z.string()).default([]),
  required_inputs: z.array(z.string()).default([]),
  auto_grade: z.boolean().default(false),
});

const zScreen = z.object({
  id: z.string().min(1),
  step_type: z.string().default(""),
  content: zRichText,
  tutor_action: z.string().default(""),
  asset_ids: z.array(z.string()).default([]),
});

const zDefinition = z.object({
  term: z.string().min(1),
  explanation: zRichText,
  origin: z.string().default(""),
});

const zWorkedExample = z.object({
  origin: z.string().default(""),
  steps: z.array(zRichText).default([]),
});

const zLesson = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  language: z.string().default("uk-UA"),
  grade: z.number().int().default(6),
  source_pages: z.array(z.string()).default([]),
  estimated_minutes: z.number().int().optional(),
  objectives: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  explanation: z.array(zRichText).default([]),
  definitions: z.array(zDefinition).default([]),
  worked_example: zWorkedExample.nullable().default(null),
  screens: z.array(zScreen).default([]),
  practice_task_ids: z.array(z.string()).default([]),
  final_check_task_ids: z.array(z.string()).default([]),
  misconceptions: z.array(z.string()).default([]),
  task_ids: z.array(z.string()).default([]),
  content_status: z.string().default(""),
  primary_reading_pages: z.array(z.string()).default([]),
  illustration_ids: z.array(z.string()).default([]),
});

const zAsset = z.object({
  id: z.string().min(1),
  page_id: z.string().default(""),
  path: z.string().min(1),
  kind: z.string().default("textbook_illustration"),
  caption: z.string().default(""),
  alt: z.string().default(""),
  tts: zTts.optional(),
  discussion_prompt: zRichText.optional(),
  source: z
    .object({
      type: z.string().default(""),
      printed_page: z.number().int().nullable().default(null),
      pdf_page: z.number().int().nullable().default(null),
      bbox_pdf_points: z.array(z.number()).default([]),
    })
    .default({ type: "", printed_page: null, pdf_page: null, bbox_pdf_points: [] }),
  rights: z.record(z.string(), z.unknown()).default({}),
  sha256: z.string().default(""),
});

const zCriterion = z.object({
  criterion: z.string(),
  met_feedback: zRichText,
  missing_feedback: zRichText,
});

const zMisconception = z.object({
  student_pattern: z.string(),
  feedback: zRichText,
  next_action: zRichText,
});

const zTaskKey = z.object({
  task_id: z.string().min(1),
  hints: z.array(zRichText).default([]),
  solution_steps: z.array(zRichText).default([]),
  answer: zRichText.optional(),
  answer_kind: z.string().default(""),
  criteria: z.array(zCriterion).default([]),
  acceptable_alternatives: z.array(z.string()).default([]),
  misconceptions: z.array(zMisconception).default([]),
});

const zTaskTable = z.object({
  id: z.string().min(1),
  task_id: z.string().min(1),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
  source_pages: z.array(z.string()).default([]),
  empty_cells_are_student_input: z.boolean().default(true),
  origin: z.string().default(""),
});

export type ParsedLesson = z.infer<typeof zLesson>;
export type ParsedTask = z.infer<typeof zTask>;
export type ParsedAsset = z.infer<typeof zAsset>;
export type ParsedTaskKey = z.infer<typeof zTaskKey>;
export type ParsedTaskTable = z.infer<typeof zTaskTable>;

export interface ParsedLiteratureV2Package {
  bookId: string | null;
  lessons: ParsedLesson[];
  tasks: ParsedTask[];
  assets: ParsedAsset[];
  taskKeys: ParsedTaskKey[];
  taskTables: ParsedTaskTable[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

/** Parses one array field; invalid items are skipped and reported, never silently dropped nor thrown (same convention as `mathCourseV2Import.ts`'s `parseArray`). */
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

export function parseLiteratureV2Course(raw: unknown): { lessons: ParsedLesson[]; tasks: ParsedTask[]; bookId: string | null; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const file = "public/course.json";
  const top = z.object({ book_id: z.string().min(1) }).safeParse(raw);
  if (!top.success) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.error.issues.map((i) => i.message).join("; ")}` });
    return { lessons: [], tasks: [], bookId: null, errors };
  }
  const obj = raw as Record<string, unknown>;
  return {
    lessons: parseArray(obj.lessons, zLesson, file, "lessons", errors),
    tasks: parseArray(obj.tasks, zTask, file, "tasks", errors),
    bookId: top.data.book_id,
    errors,
  };
}

export function parseLiteratureV2Teacher(raw: unknown): { taskKeys: ParsedTaskKey[]; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const file = "private/teacher.json";
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).items)) {
    errors.push({ file, field: "$", message: "не відповідає контракту: очікувався об'єкт з полем items[]" });
    return { taskKeys: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  return { taskKeys: parseArray(obj.items, zTaskKey, file, "items", errors), errors };
}

export function parseLiteratureV2Assets(raw: unknown): { assets: ParsedAsset[]; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  // `catalog/assets.json` bundles two different entry shapes under one
  // array (kind="textbook_illustration" — an actual image file — and
  // kind="task_table", a redundant inline copy of the SAME rows already in
  // `catalog/task_tables.json`, with no `path` since it is not a file).
  // Only the illustrations are this function's job; the table copies are
  // intentionally skipped here, never reported as errors.
  const illustrationsOnly = Array.isArray(raw) ? raw.filter((item) => (item as Record<string, unknown> | null)?.kind !== "task_table") : raw;
  return { assets: parseArray(illustrationsOnly, zAsset, "catalog/assets.json", "$", errors), errors };
}

export function parseLiteratureV2TaskTables(raw: unknown): { taskTables: ParsedTaskTable[]; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  return { taskTables: parseArray(raw, zTaskTable, "catalog/task_tables.json", "$", errors), errors };
}

/**
 * Combines the already-parsed documents and cross-checks referential
 * integrity (every task should have a key; every key/table should point at
 * a real task) — mismatches are WARNINGS, not fatal, same convention as
 * `mathCourseV2Import.ts`'s `combineMathCourseV2Package`.
 */
export function combineLiteratureV2Package(
  course: { lessons: ParsedLesson[]; tasks: ParsedTask[]; bookId: string | null; errors: ImportIssue[] },
  teacher: { taskKeys: ParsedTaskKey[]; errors: ImportIssue[] },
  assets: { assets: ParsedAsset[]; errors: ImportIssue[] },
  taskTables: { taskTables: ParsedTaskTable[]; errors: ImportIssue[] },
): ParsedLiteratureV2Package {
  const warnings: ImportIssue[] = [];
  const taskIds = new Set(course.tasks.map((t) => t.id));

  const taskKeys = teacher.taskKeys.filter((k) => {
    if (!taskIds.has(k.task_id)) {
      warnings.push({ file: "private/teacher.json", field: `items.${k.task_id}`, message: `task_id "${k.task_id}" не знайдено серед public.tasks — ключ пропущено` });
      return false;
    }
    return true;
  });
  const keyedTaskIds = new Set(taskKeys.map((k) => k.task_id));
  for (const t of course.tasks) {
    if (!keyedTaskIds.has(t.id)) warnings.push({ file: "private/teacher.json", field: "items", message: `завдання "${t.id}" не має приватного ключа — підказки й критерії будуть недоступні` });
  }

  const taskTableRows = taskTables.taskTables.filter((tt) => {
    if (!taskIds.has(tt.task_id)) {
      warnings.push({ file: "catalog/task_tables.json", field: `$.${tt.id}`, message: `task_id "${tt.task_id}" не знайдено серед public.tasks — таблицю пропущено` });
      return false;
    }
    return true;
  });

  return {
    bookId: course.bookId,
    lessons: course.lessons,
    tasks: course.tasks,
    assets: assets.assets,
    taskKeys,
    taskTables: taskTableRows,
    errors: [...course.errors, ...teacher.errors, ...assets.errors, ...taskTables.errors],
    warnings,
  };
}
