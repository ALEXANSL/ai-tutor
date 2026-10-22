import "server-only";
import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { readSafeCourseZip } from "./safeCourseZip";
import { collectReferencedAssetFiles } from "./courseAssetFiles";
import { parseCoursePackageZip, type ParsedCoursePackage, type ImportIssue } from "./courseImport";
import { parseLiteratureCourseZip, type ParsedCourseResult } from "./literatureImport";
import { combineMathCourseV2Package, parseMathCourseV2Public, parseMathCourseV2Private, type ParsedMathCourseV2Package } from "./mathCourseV2Import";
import { combineLiteratureV2Package, parseLiteratureV2Course, parseLiteratureV2Teacher, parseLiteratureV2Assets, parseLiteratureV2TaskTables, type ParsedLiteratureV2Package } from "./literatureV2Import";
import { combineLiteratureV3Package, parseLiteratureV3PackageManifest, parseLiteratureV3Course, parseLiteratureV3Readings, parseLiteratureV3Teacher, parseLiteratureV3Assets, parseLiteratureV3Pages, parseLiteratureV3TaskTables, type ParsedLiteratureV3Package } from "./literatureV3Import";

export type UnifiedArchiveFormat = "chapter_v3" | "math_v2" | "literature_v2" | "course_v1" | "markdown_v1";
interface ArchiveBase {
  packageId: string;
  title: string;
  counts: { lessons: number; tasks: number; images: number; pdfs: number };
  errors: ImportIssue[];
  warnings: ImportIssue[];
  assetFiles: Map<string, Uint8Array>;
}
export type UnifiedCourseArchive = ArchiveBase & (
  | { format: "chapter_v3"; parsed: ParsedLiteratureV3Package }
  | { format: "math_v2"; parsed: ParsedMathCourseV2Package }
  | { format: "literature_v2"; parsed: ParsedLiteratureV2Package }
  | { format: "course_v1"; parsed: ParsedCoursePackage }
  | { format: "markdown_v1"; parsed: ParsedCourseResult }
);
type JsonRecord = Record<string, unknown>;
const record = (raw: unknown): JsonRecord => raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonRecord : {};

function json(entries: Record<string, Uint8Array>, paths: string[], required = true): unknown {
  const matches = paths.filter(path => entries[path]);
  if (matches.length > 1) throw new Error(`У пакеті кілька версій ${paths[0]}. Залиште один файл.`);
  if (!matches.length) {
    if (required) throw new Error(`У пакеті бракує ${paths[0]}. Перевірте повний ZIP курсу.`);
    return undefined;
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries[matches[0]!])); }
  catch { throw new Error(`Файл ${matches[0]} не є коректним JSON у UTF-8.`); }
}
function version(raw: unknown, field: string, expected: string | string[], file: string): void {
  const value = record(raw)[field];
  if (value != null && !(Array.isArray(expected) ? expected.includes(String(value)) : value === expected)) throw new Error(`${file}: непідтримувана версія ${String(value)}; очікується ${expected}.`);
}
function unique(errors: ImportIssue[], file: string, field: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push({ file, field, message: `Дублюється ідентифікатор «${id}».` });
    seen.add(id);
  }
}
function finalize<T extends UnifiedCourseArchive>(result: T, entries: Record<string, Uint8Array>, assetPaths: string[] = []): T {
  if (!result.counts.lessons) result.errors.push({ file: "public/course.json", field: "lessons", message: "У пакеті немає жодного придатного уроку." });
  for (const path of assetPaths) {
    if (!result.assetFiles.has(path)) result.warnings.push({ file: path, field: "media", message: "Медіафайл відсутній у ZIP. Текстові уроки доступні; раніше завантажений файл має бути збережений." });
  }
  result.counts.images = [...result.assetFiles.keys()].filter(path => /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(path)).length;
  result.counts.pdfs = [...result.assetFiles.keys()].filter(path => /\.pdf$/i.test(path)).length;
  if (Object.keys(entries).some(path => /(?:^|\/)tsk_table\.json$/i.test(path))) result.warnings.push({ file: "tsk_table.json", field: "name", message: "Назва tsk_table.json не підтримується. Правильне ім’я каталогу — catalog/task_tables.json." });
  return result;
}

/** One subject-neutral package root; do not guess among multiple courses or
 * silently fall through after a recognized manifest fails validation. */
function packageEntries(all: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const roots = new Set<string>();
  const names = Object.keys(all);
  for (const path of names) {
    if (/(?:^|\/)manifest\.json$/.test(path)) roots.add(path.slice(0, -"manifest.json".length));
    if (/(?:^|\/)public\/course\.json$/.test(path)) roots.add(path.slice(0, -"public/course.json".length));
    else if (/(?:^|\/)course\.json$/.test(path)) {
      const root = path.slice(0, -"course.json".length);
      if (all[`${root}teacher.json`] || all[`${root}private/teacher.json`] || all[`${root}package.json`]) roots.add(root);
    }
    if (/(?:^|\/)package\.json$/.test(path)) {
      const root = path.slice(0, -"package.json".length);
      if (all[`${root}public/course.json`] || all[`${root}course.json`]) roots.add(root);
    }
  }
  if (!roots.size) {
    for (const path of names) {
      const match = /^(.*)lessons\/[^/]+\.md$/i.exec(path);
      if (match) roots.add(match[1]!);
    }
  }
  if (roots.size > 1) throw new Error("У ZIP знайдено кілька пакетів курсу. Завантажте один курс в одному архіві.");
  if (!roots.size) throw new Error("Не знайдено пакет курсу: потрібні package.json і JSON матеріалів, старий manifest.json або lessons/*.md.");
  const root = [...roots][0]!;
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const [path, bytes] of Object.entries(all)) {
    if (path.startsWith(root)) entries[path.slice(root.length)] = bytes;
  }
  return entries;
}

/** Pure parser only: no storage, SQL, AI, shell execution or child-facing keys.
 * `parsed` contains server-private teacher data and MUST stay server-side.
 * Callers must block persistence when `errors.length > 0`. */
export function parseUnifiedCourseArchive(zipBytes: Uint8Array): UnifiedCourseArchive {
  const entries = packageEntries(readSafeCourseZip(zipBytes));
  const counts = { lessons: 0, tasks: 0, images: 0, pdfs: 0 };
  if (entries["manifest.json"]) {
    const rawManifest = json(entries, ["manifest.json"]);
    version(rawManifest, "schema_version", "1.0.0", "manifest.json");
    const parsed = parseCoursePackageZip(zipSync(entries, { level: 0 }));
    return finalize({ format: "course_v1", packageId: parsed.manifest?.id ?? "", title: parsed.manifest?.title ?? "Курс", counts: { ...counts, lessons: parsed.lessons.length, tasks: parsed.exercises.length + [...parsed.testsByLessonKey.values()].reduce((sum, test) => sum + test.automaticQuestions.length, 0) }, errors: parsed.errors, warnings: parsed.warnings, assetFiles: parsed.assetFiles, parsed }, entries);
  }
  const hasCourse = !!(entries["public/course.json"] || entries["course.json"]);
  if (!hasCourse) {
    const parsed = parseLiteratureCourseZip(zipSync(entries, { level: 0 }));
    const packageId = `markdown-${createHash("sha256").update(zipBytes).digest("hex").slice(0, 24)}`;
    return finalize({ format: "markdown_v1", packageId, title: "Текстові уроки", counts: { ...counts, lessons: parsed.topics.length, tasks: parsed.topics.reduce((sum, topic) => sum + topic.test.questions.length, 0) }, errors: [], warnings: parsed.warnings.map(issue => ({ file: issue.topicNo == null ? null : `lessons/${issue.topicNo}.md`, field: issue.field, message: issue.message })), assetFiles: new Map(), parsed }, entries);
  }
  const course = json(entries, ["public/course.json", "course.json"]);
  const teacher = json(entries, ["private/teacher.json", "teacher.json"]);
  const packageJson = json(entries, ["package.json"], false);
  const packageRecord = record(packageJson);
  const chapter = typeof packageRecord.format === "string" || !!entries["public/readings.json"] || !!entries["readings.json"]
    || (Array.isArray(record(course).lessons) && (record(course).lessons as unknown[]).some(lesson => Array.isArray(record(lesson).flow)));
  if (chapter) {
    if (!packageJson) throw new Error("Це спільний формат уроків із flow/readings. У ZIP бракує package.json; це не старий формат літератури.");
    version(packageJson, "schema_version", ["2.0.0", "2.0.1", "2.1.0"], "package.json");
    version(course, "schema_version", ["2.0.0", "2.0.1", "2.1.0"], "public/course.json");
    const readings = json(entries, ["public/readings.json", "readings.json"]);
    const assets = json(entries, ["catalog/assets.json", "assets.json"], false) ?? { items: [] };
    const pages = json(entries, ["catalog/pages.json", "pages.json"], false) ?? { items: [] };
    const taskTables = json(entries, ["catalog/task_tables.json", "task_tables.json"], false);
    const parsed = combineLiteratureV3Package(parseLiteratureV3PackageManifest(packageJson), parseLiteratureV3Course(course), parseLiteratureV3Readings(readings), parseLiteratureV3Teacher(teacher), parseLiteratureV3Assets(assets), parseLiteratureV3Pages(pages), taskTables === undefined ? { warnings: [], errors: [] } : parseLiteratureV3TaskTables(taskTables));
    const id = parsed.manifest?.book_id ?? "";
    for (const [label, raw] of [["course", course], ["readings", readings], ["teacher", teacher], ["assets", assets], ["pages", pages], ["task_tables", taskTables]] as const) {
      if (record(raw).book_id != null && record(raw).book_id !== id) parsed.errors.push({ file: `${label}.json`, field: "book_id", message: "book_id не збігається з package.json." });
    }
    unique(parsed.errors, "public/course.json", "lessons", parsed.lessons.map(lesson => lesson.id));
    unique(parsed.errors, "public/course.json", "tasks", parsed.tasks.map(task => task.id));
    unique(parsed.errors, "public/readings.json", "items", parsed.readingItems.map(item => item.id));
    const workIds = new Set(parsed.works.map(work => work.id));
    for (const item of parsed.readingItems) if (!workIds.has(item.work_id)) parsed.errors.push({ file: "public/readings.json", field: item.id, message: `Не знайдено твір ${item.work_id} для читання.` });
    const critical = parsed.warnings.filter(issue => issue.file === "private/teacher.json" || issue.field.endsWith(".flow"));
    parsed.errors.push(...critical);
    const paths = parsed.assets.map(asset => asset.path);
    const pdfPaths = parsed.assets.filter(asset => asset.kind === "lesson_pdf").map(asset => asset.path);
    const assetFiles = collectReferencedAssetFiles(entries, paths, pdfPaths);
    return finalize({ format: "chapter_v3", packageId: id, title: parsed.manifest?.source_edition || id, counts: { ...counts, lessons: parsed.lessons.length, tasks: parsed.tasks.length }, errors: parsed.errors, warnings: parsed.warnings.filter(issue => !critical.includes(issue)), assetFiles, parsed }, entries, paths);
  }
  if ("package_schema_version" in record(course) || "course" in record(course) || record(course).audience === "student") {
    version(course, "package_schema_version", "1.0.0", "public/course.json");
    version(teacher, "package_schema_version", "1.0.0", "private/teacher.json");
    const pub = parseMathCourseV2Public(course);
    const priv = parseMathCourseV2Private(teacher);
    const parsed = combineMathCourseV2Package(pub.data, priv);
    if (priv.courseId !== parsed.course?.id) parsed.errors.push({ file: "private/teacher.json", field: "course_id", message: "Ідентифікатор курсу не збігається з public/course.json." });
    unique(parsed.errors, "public/course.json", "lessons", parsed.lessons.map(lesson => lesson.id));
    unique(parsed.errors, "public/course.json", "questions", parsed.questions.map(question => question.id));
    unique(parsed.errors, "public/course.json", "exercises", parsed.exercises.map(exercise => exercise.id));
    for (const question of parsed.questions) {
      const key = parsed.questionKeys.find(item => item.question_id === question.id);
      if (!key || !question.options.some(option => option.id === key.correct_option_id)) parsed.errors.push({ file: "private/teacher.json", field: question.id, message: "Питання не має валідного ключа для перевірки відповіді." });
    }
    const paths = parsed.assets.map(asset => asset.path);
    return finalize({ format: "math_v2", packageId: parsed.course?.id ?? "", title: parsed.course?.title ?? "Курс", counts: { ...counts, lessons: parsed.lessons.length, tasks: parsed.exercises.length + parsed.questions.length }, errors: parsed.errors, warnings: parsed.warnings, assetFiles: collectReferencedAssetFiles(entries, paths), parsed }, entries, paths);
  }
  if (!("book_id" in record(course))) throw new Error("Не вдалося визначити версію пакета за вмістом course.json. Скористайтеся актуальним універсальним промптом.");
  version(course, "schema_version", "1.0.0", "public/course.json");
  const assets = json(entries, ["catalog/assets.json", "assets.json"], false) ?? [];
  const tables = json(entries, ["catalog/task_tables.json", "task_tables.json"], false) ?? [];
  const parsed = combineLiteratureV2Package(parseLiteratureV2Course(course), parseLiteratureV2Teacher(teacher), parseLiteratureV2Assets(assets), parseLiteratureV2TaskTables(tables));
  const teacherBook = record(teacher).book_id;
  if (teacherBook != null && teacherBook !== parsed.bookId) parsed.errors.push({ file: "private/teacher.json", field: "book_id", message: "book_id не збігається з public/course.json." });
  unique(parsed.errors, "public/course.json", "lessons", parsed.lessons.map(lesson => lesson.id));
  unique(parsed.errors, "public/course.json", "tasks", parsed.tasks.map(task => task.id));
  const critical = parsed.warnings.filter(issue => issue.file === "private/teacher.json");
  parsed.errors.push(...critical);
  const paths = parsed.assets.map(asset => asset.path);
  return finalize({ format: "literature_v2", packageId: parsed.bookId ?? "", title: parsed.bookId ?? "Курс", counts: { ...counts, lessons: parsed.lessons.length, tasks: parsed.tasks.length }, errors: parsed.errors, warnings: parsed.warnings, assetFiles: collectReferencedAssetFiles(entries, paths), parsed }, entries, paths);
}
