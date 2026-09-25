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
};

export function familyColumn(table: string): string {
  return FAMILY_COLUMN[table] ?? "family_id";
}

export function forFamily(familyId: string, client: SupabaseClient = createServiceClient()) {
  if (!familyId) throw new Error("forFamily: familyId is required");
  return {
    familyId,
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
  };
}

export type FamilyScope = ReturnType<typeof forFamily>;

/** Family time zone from data (never hard-coded; ADR-018 K-4). */
export async function getFamilyTimezone(scope: FamilyScope): Promise<string> {
  const { data } = await scope.select("families", "timezone").maybeSingle<{ timezone: string }>();
  return data?.timezone ?? "UTC";
}
