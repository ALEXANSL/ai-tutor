import "server-only";
import { z } from "zod";

/**
 * S35 ($0 math course-package v2 importer, PO instruction 2026-10-07) —
 * pure parsing/validation of the real "Істер, математика, частина 1"
 * package contract (`IMPORT_CONTRACT.md`/`schema/public.schema.json`/
 * `schema/private.schema.json`, read in full before writing this file; a
 * trimmed copy of both schemas' shapes lives in
 * `__fixtures__/math-course-v2/`). ZERO AI calls anywhere in this file —
 * every lesson/screen/question/exercise text is already finished,
 * human-written content; this is schema validation only.
 *
 * Two separate JSON documents, not a zip:
 *   - `public/course.json` — everything the CHILD may see (course, assets,
 *     lessons, screens, questions, quizzes, quiz_items, exercises). Never
 *     contains a correct answer anywhere.
 *   - `private/teacher.json` — question_keys (correct_option_id, hint,
 *     explanation, per-option feedback), exercise_solutions (step-by-step
 *     parts), source_issues (ambiguous-exercise warnings). Parsed here only
 *     so the import pipeline can persist it into the private, client-
 *     unreadable tables — never returned to a browser.
 *
 * Like `courseImport.ts` (S34), this package's schema is the AUTHOR's own
 * strict contract: a required field missing is a real defect in the
 * package, not something to paper over, so the affected row is skipped and
 * reported (file + field + message) rather than guessed at. Unlike S34,
 * this package has essentially no optional/missing-field slack by design
 * (`completion_status: "full_lesson_scope_complete_..."`) — the skip path
 * exists mainly for forward-compatibility with a future, less-complete
 * revision of the same course.
 */

export interface ImportIssue {
  file: string;
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Zod schemas — mirror schema/public.schema.json / schema/private.schema.json.
// ---------------------------------------------------------------------------

const zCourse = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subject: z.string().min(1),
  language: z.string().min(1),
  grade: z.number().int(),
  part: z.number().int(),
  content_revision: z.string(),
  source_file_name: z.string(),
  source_sha256: z.string(),
  completion_status: z.string(),
});

const zBboxOrEmpty = z.array(z.number()).optional().default([]);

const zAsset = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  mime_type: z.string().min(1),
  alt: z.string(),
  source: z.object({
    printed_page: z.number().int().nullable(),
    pdf_page: z.number().int().nullable(),
    bbox_pt: zBboxOrEmpty,
  }),
  width_px: z.number().int(),
  height_px: z.number().int(),
  physical_width_mm: z.number(),
  physical_height_mm: z.number(),
  scale_pixels_per_pdf_point: z.number(),
  sha256: z.string(),
  size_bytes: z.number().int(),
});

const LESSON_KINDS = ["lesson", "review", "assessment"] as const;

const zLesson = z.object({
  id: z.string().min(1),
  order: z.number().int(),
  title: z.string().min(1),
  kind: z.enum(LESSON_KINDS),
  source: z.record(z.string(), z.unknown()),
  objectives: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]),
  screen_ids: z.array(z.string()),
  exercise_ids: z.array(z.unknown()).default([]),
  guided_practice_question_ids: z.array(z.string()).default([]),
  quiz_id: z.string().nullable().default(null),
  pending_exercise_count: z.number().int().default(0),
});

const zScreen = z.object({
  id: z.string().min(1),
  role: z.string(),
  title: z.string(),
  narration: z.string(),
  pause_after: z.boolean().default(false),
  lesson_id: z.string().min(1),
  order: z.number().int(),
  display_md: z.string(),
  equations_latex: z.array(z.unknown()).default([]),
});

const zQuestionOption = z.object({
  id: z.string().min(1),
  display_md: z.string(),
  narration: z.string(),
});

const zQuestion = z.object({
  id: z.string().min(1),
  lesson_id: z.string().min(1),
  max_points: z.number().int().default(1),
  options: z.array(zQuestionOption).min(2),
  display_md: z.string(),
  narration: z.string(),
});

const zQuiz = z.object({
  id: z.string().min(1),
  lesson_id: z.string().min(1),
  title: z.string(),
  question_count: z.number().int().default(0),
  max_points: z.number().int().default(0),
  mastery_threshold: z.number().default(0.8),
  scoring: z.string().default(""),
});

const zQuizItem = z.object({
  id: z.string().min(1),
  quiz_id: z.string().min(1),
  question_id: z.string().min(1),
  order: z.number().int(),
  max_points: z.number().int().default(1),
});

const zExercise = z.object({
  id: z.string().min(1),
  lesson_id: z.string().min(1),
  original_number: z.string().min(1),
  origin: z.string().default("textbook"),
  display_md: z.string(),
  narration: z.string(),
  asset_ids: z.array(z.string()).default([]),
  status: z.string().default(""),
  grading_mode: z.string().default(""),
});

const zOptionFeedback = z.object({
  id: z.string().min(1),
  feedback: z.string(),
  feedback_narration: z.string(),
});

const zQuestionKey = z.object({
  id: z.string().min(1),
  question_id: z.string().min(1),
  correct_option_id: z.string().min(1),
  hint: z.string().default(""),
  hint_narration: z.string().default(""),
  explanation_md: z.string().default(""),
  explanation_narration: z.string().default(""),
  // Null for a question with no automatically-checkable numeric answer
  // (e.g. a reasoning/open-ended pick among options) — the package's own
  // contract never guarantees one; `correct_option_id` above is the only
  // thing `submitQuestionAnswerAction` actually needs to grade.
  certificate: z.record(z.string(), z.unknown()).nullable().default({}),
  option_feedback: z.array(zOptionFeedback).default([]),
  equations_latex: z.array(z.unknown()).default([]),
});

const zSolutionPart = z.object({
  label: z.string(),
  steps_md: z.array(z.string()),
  steps_narration: z.array(z.string()),
  answer_md: z.string(),
  answer_narration: z.string(),
  equations_latex: z.array(z.unknown()).default([]),
  // Same as `zQuestionKey.certificate` above — null for a solution part with
  // no single checkable numeric answer (a construction/measurement step).
  certificate: z.record(z.string(), z.unknown()).nullable().optional(),
});

const zExerciseSolution = z.object({
  id: z.string().min(1),
  exercise_id: z.string().min(1),
  lesson_id: z.string().min(1),
  prompt_md: z.string().default(""),
  prompt_narration: z.string().default(""),
  hint: z.string().default(""),
  parts: z.array(zSolutionPart).min(1),
  status: z.string().default(""),
  verification_note: z.string().optional().default(""),
});

const zSourceIssue = z.object({
  id: z.string().min(1),
  exercise_id: z.string().min(1),
  issue: z.record(z.string(), z.unknown()),
});

export type ParsedAsset = z.infer<typeof zAsset>;
export type ParsedLesson = z.infer<typeof zLesson>;
export type ParsedScreen = z.infer<typeof zScreen>;
export type ParsedQuestion = z.infer<typeof zQuestion>;
export type ParsedQuiz = z.infer<typeof zQuiz>;
export type ParsedQuizItem = z.infer<typeof zQuizItem>;
export type ParsedExercise = z.infer<typeof zExercise>;
export type ParsedQuestionKey = z.infer<typeof zQuestionKey>;
export type ParsedExerciseSolution = z.infer<typeof zExerciseSolution>;
export type ParsedSourceIssue = z.infer<typeof zSourceIssue>;

export interface ParsedMathCourseV2Package {
  course: z.infer<typeof zCourse> | null;
  assets: ParsedAsset[];
  lessons: ParsedLesson[];
  screens: ParsedScreen[];
  questions: ParsedQuestion[];
  quizzes: ParsedQuiz[];
  quizItems: ParsedQuizItem[];
  exercises: ParsedExercise[];
  questionKeys: ParsedQuestionKey[];
  exerciseSolutions: ParsedExerciseSolution[];
  sourceIssues: ParsedSourceIssue[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

/**
 * A construction-template / printable figure (the child must build on it,
 * not read it as a mere illustration) — PO correction 2026-10-07. The real
 * package names these `*_ray_blank`, `*_crossword_blank`, `*_diagram_blank`,
 * `*_schemes_blank`, `*_ground_blank` — every one ends in `_blank`. Matching
 * on "blank" (not "ray") so it also catches the non-ray construction types.
 */
export function isConstructionTemplateAsset(assetKey: string): boolean {
  return /blank/i.test(assetKey);
}

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

export function parseMathCourseV2Public(raw: unknown): { data: ParsedMathCourseV2Package; errors: ImportIssue[] } {
  const errors: ImportIssue[] = [];
  const file = "public/course.json";
  const top = z
    .object({
      package_schema_version: z.string(),
      audience: z.literal("student"),
      course: zCourse,
    })
    .safeParse(raw);
  if (!top.success) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.error.issues.map((i) => i.message).join("; ")}` });
    return {
      data: { course: null, assets: [], lessons: [], screens: [], questions: [], quizzes: [], quizItems: [], exercises: [], questionKeys: [], exerciseSolutions: [], sourceIssues: [], errors, warnings: [] },
      errors,
    };
  }
  const obj = raw as Record<string, unknown>;
  return {
    data: {
      course: top.data.course,
      assets: parseArray(obj.assets, zAsset, file, "assets", errors),
      lessons: parseArray(obj.lessons, zLesson, file, "lessons", errors),
      screens: parseArray(obj.screens, zScreen, file, "screens", errors),
      questions: parseArray(obj.questions, zQuestion, file, "questions", errors),
      quizzes: parseArray(obj.quizzes, zQuiz, file, "quizzes", errors),
      quizItems: parseArray(obj.quiz_items, zQuizItem, file, "quiz_items", errors),
      exercises: parseArray(obj.exercises, zExercise, file, "exercises", errors),
      questionKeys: [],
      exerciseSolutions: [],
      sourceIssues: [],
      errors,
      warnings: [],
    },
    errors,
  };
}

export interface ParsedPrivateTeacher {
  courseId: string | null;
  tutorPolicy: string;
  questionKeys: ParsedQuestionKey[];
  exerciseSolutions: ParsedExerciseSolution[];
  sourceIssues: ParsedSourceIssue[];
  errors: ImportIssue[];
}

export function parseMathCourseV2Private(raw: unknown): ParsedPrivateTeacher {
  const errors: ImportIssue[] = [];
  const file = "private/teacher.json";
  const top = z.object({ package_schema_version: z.string(), audience: z.literal("teacher_server"), course_id: z.string().min(1) }).safeParse(raw);
  if (!top.success) {
    errors.push({ file, field: "$", message: `не відповідає контракту: ${top.error.issues.map((i) => i.message).join("; ")}` });
    return { courseId: null, tutorPolicy: "", questionKeys: [], exerciseSolutions: [], sourceIssues: [], errors };
  }
  const obj = raw as Record<string, unknown>;
  return {
    courseId: top.data.course_id,
    tutorPolicy: typeof obj.tutor_policy === "string" ? obj.tutor_policy : "",
    questionKeys: parseArray(obj.question_keys, zQuestionKey, file, "question_keys", errors),
    exerciseSolutions: parseArray(obj.exercise_solutions, zExerciseSolution, file, "exercise_solutions", errors),
    sourceIssues: parseArray(obj.source_issues, zSourceIssue, file, "source_issues", errors),
    errors,
  };
}

/**
 * Combines the two already-parsed documents, cross-checks referential
 * integrity (every question has a key, every exercise with a source_issue
 * exists, etc. — mismatches are WARNINGS, not fatal: the package's own
 * `course_id` match between the two files is checked by the caller, not
 * here) and returns one package ready for `mathCourseV2Persist.ts`.
 */
export function combineMathCourseV2Package(pub: ParsedMathCourseV2Package, priv: ParsedPrivateTeacher): ParsedMathCourseV2Package {
  const warnings: ImportIssue[] = [];
  const questionIds = new Set(pub.questions.map((q) => q.id));
  const exerciseIds = new Set(pub.exercises.map((e) => e.id));

  const questionKeys = priv.questionKeys.filter((k) => {
    if (!questionIds.has(k.question_id)) {
      warnings.push({ file: "private/teacher.json", field: `question_keys.${k.id}`, message: `question_id "${k.question_id}" не знайдено серед public.questions — ключ пропущено` });
      return false;
    }
    return true;
  });
  // Any public question WITHOUT a key is unanswerable safely — reported so
  // the parent sees it, not discovered by a child mid-lesson.
  const keyedQuestionIds = new Set(questionKeys.map((k) => k.question_id));
  for (const q of pub.questions) {
    if (!keyedQuestionIds.has(q.id)) warnings.push({ file: "private/teacher.json", field: `question_keys`, message: `питання "${q.id}" не має приватного ключа — тест не зможе перевірити відповідь` });
  }

  const exerciseSolutions = priv.exerciseSolutions.filter((s) => {
    if (!exerciseIds.has(s.exercise_id)) {
      warnings.push({ file: "private/teacher.json", field: `exercise_solutions.${s.id}`, message: `exercise_id "${s.exercise_id}" не знайдено серед public.exercises — розбір пропущено` });
      return false;
    }
    return true;
  });

  const sourceIssues = priv.sourceIssues.filter((s) => {
    if (!exerciseIds.has(s.exercise_id)) {
      warnings.push({ file: "private/teacher.json", field: `source_issues.${s.id}`, message: `exercise_id "${s.exercise_id}" не знайдено серед public.exercises — попередження пропущено` });
      return false;
    }
    return true;
  });

  return {
    ...pub,
    questionKeys,
    exerciseSolutions,
    sourceIssues,
    errors: [...pub.errors, ...priv.errors],
    warnings: [...pub.warnings, ...warnings],
  };
}
