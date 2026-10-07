import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../supabase/clients";

/**
 * forFamily (ADR-018 K-2): every service-role query is scoped to the
 * caller's family. Tables with shared-capable content use owner_family_id.
 */
const FAMILY_COLUMN: Record<string, string> = {
  families: "id",
  subjects: "owner_family_id",
  materials: "owner_family_id",
  manual_import_batches: "owner_family_id",
  material_sections: "owner_family_id",
  topics: "owner_family_id",
  topic_dependencies: "owner_family_id",
  material_topic_links: "owner_family_id",
  material_problems: "owner_family_id",
  chunks: "owner_family_id",
  material_ocr_pages: "owner_family_id",
  library_items: "owner_family_id",
  library_steps: "owner_family_id",
  library_item_reviews: "owner_family_id",
  // S33 (literature extraction, see supabase/migrations/20260930120000_s33_literature_extraction.sql).
  // FIX 2026-10-07 (STATUS.md's 2026-10-02 open item, "перевірити першим
  // ділом завтра"): confirmed by reading this map and the S33 `create
  // table` statements side by side — both tables were genuinely missing
  // here and have ONLY `owner_family_id`, never `family_id` (this map's
  // fallback). Every `forFamily(familyId).select("literature_lessons"/
  // "literature_lesson_tests", ...)` call in `literatureView.ts` was
  // therefore chaining `.eq("family_id", familyId)` against a column
  // neither table has; PostgREST rejects an unknown filter column (42703),
  // and every call site here destructures only `{ data }` (discards
  // `error`), so the failure silently reads as "not found" rather than
  // throwing. git blame shows `forFamily` was used from this file's very
  // first commit (`b13696e`) — I could NOT reconcile that with the
  // 2026-10-01 PO demo of the same lesson having gone well; I did not
  // reproduce the live app to settle it either way in this slice. What IS
  // settled: the column names above are factually correct (verified
  // against the migration, not inferred), and this entry is the correct
  // fix regardless of how/when the bug was actually hit in production.
  // Recommend Alex spot-check one real literature lesson after deploying
  // this fix, specifically because its prior behavior is unexplained.
  literature_lessons: "owner_family_id",
  literature_lesson_tests: "owner_family_id",
  // S34 ($0 course-package importer, see supabase/migrations/20261016100000_s34_course_import.sql).
  course_packages: "owner_family_id",
  course_package_assets: "owner_family_id",
  course_lessons: "owner_family_id",
  course_lesson_tests: "owner_family_id",
  course_exercises: "owner_family_id",
  // S35 (math course package v2 importer, see supabase/migrations/20261017100000_s35_math_course_v2.sql).
  course_v2_packages: "owner_family_id",
  course_v2_assets: "owner_family_id",
  course_v2_lessons: "owner_family_id",
  course_v2_screens: "owner_family_id",
  course_v2_questions: "owner_family_id",
  course_v2_quizzes: "owner_family_id",
  course_v2_quiz_items: "owner_family_id",
  course_v2_exercises: "owner_family_id",
  course_v2_question_attempts: "owner_family_id",
  course_v2_narration_cache: "owner_family_id",
  // Deliberately NOT in this map: course_v2_question_keys,
  // course_v2_exercise_solutions, course_v2_source_issues — these are never
  // read through `forFamily`/the generic scope helper at all (no select
  // RLS grant exists for them either, see the S35 migration). They are
  // read ONLY via `createServiceClient()` directly inside
  // `app/src/app/actions/math-course-v2.ts`'s two server actions, each of
  // which narrows by the specific `question_id`/`exercise_id` the child
  // just answered/asked about — adding them here would wrongly suggest a
  // generic family-scoped read path exists for key/solution data.
};

export function familyColumn(table: string): string {
  return FAMILY_COLUMN[table] ?? "family_id";
}

export function forFamily(familyId: string, client: SupabaseClient = createServiceClient()) {
  if (!familyId) throw new Error("forFamily: familyId is required");
  return {
    familyId,
    /** Raw client for RPCs; RPCs must receive `familyId` explicitly. */
    client,
    select(table: string, columns = "*") {
      return client.from(table).select(columns).eq(familyColumn(table), familyId);
    },
    count(table: string) {
      return client.from(table).select("*", { count: "exact", head: true }).eq(familyColumn(table), familyId);
    },
    insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, [familyColumn(table)]: familyId }));
      return client.from(table).insert(list);
    },
    update(table: string, values: Record<string, unknown>) {
      return client.from(table).update(values).eq(familyColumn(table), familyId);
    },
    upsert(table: string, rows: Record<string, unknown> | Record<string, unknown>[], onConflict?: string) {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, [familyColumn(table)]: familyId }));
      return client.from(table).upsert(list, onConflict ? { onConflict } : undefined);
    },
    delete(table: string) {
      return client.from(table).delete().eq(familyColumn(table), familyId);
    },
  };
}

export type FamilyScope = ReturnType<typeof forFamily>;

/** Family time zone from data (never hard-coded; ADR-018 K-4). */
export async function getFamilyTimezone(scope: FamilyScope): Promise<string> {
  const { data } = await scope.select("families", "timezone").maybeSingle<{ timezone: string }>();
  return data?.timezone ?? "UTC";
}
