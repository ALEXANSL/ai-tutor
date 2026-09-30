"use server";

import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { runLiteratureExtraction } from "@/server/lessons/literatureExtraction";
import { createServiceClient } from "@/server/supabase/clients";
import { uk } from "@/i18n/uk";

/**
 * S33 follow-up (2026-09-30): "Згенерувати уроки" button in
 * `/parent/settings` — the PO does not run terminal commands, so this
 * server action is the one-time admin trigger for
 * `runLiteratureExtraction` (`literatureExtraction.ts`), previously only
 * reachable via `scripts/run-literature-extraction.ts`. Same call, same
 * inputs, no new logic here — just the parent-access gate + the same
 * material/subject lookups the CLI script does, reported back as a
 * summary instead of printed to a console the PO never opens.
 *
 * Mirrors the CLI script's own family resolution: the acting family is the
 * BOOK'S owner family (`materials.owner_family_id`), not necessarily the
 * calling parent's own family id — same as the CLI's `--family` default.
 * `requireParentAccess()` only gates "is this caller a parent at all", same
 * access level as the rest of `/parent/settings` (see
 * `ContentQaSweepPanel`'s doc for the precedent).
 */

const UUID = z.string().uuid();

export interface LiteratureExtractionTopicSummary {
  topicNo: number;
  status: "active" | "needs_review";
  failuresCount: number;
}

export interface LiteratureExtractionSummary {
  materialTitle: string;
  subjectName: string;
  groups: number;
  topics: LiteratureExtractionTopicSummary[];
  active: number;
  needsReview: number;
  driveWriteFailures: { topicNo: number; reason: string }[];
  totalCostUsd: number;
}

export type LiteratureExtractionState = { status: "ok"; summary: LiteratureExtractionSummary } | { status: "error"; message: string };

export async function runLiteratureExtractionAction(materialId: string, subjectId: string): Promise<LiteratureExtractionState> {
  await requireParentAccess();

  const materialParsed = UUID.safeParse(materialId);
  const subjectParsed = UUID.safeParse(subjectId);
  if (!materialParsed.success || !subjectParsed.success) {
    return { status: "error", message: "Невірний ідентифікатор підручника або предмета." };
  }

  try {
    const client = createServiceClient();
    const { data: material, error: materialError } = await client
      .from("materials")
      .select("id, owner_family_id, title, name, grade")
      .eq("id", materialParsed.data)
      .single<{ id: string; owner_family_id: string; title: string | null; name: string; grade: number | null }>();
    if (materialError || !material) {
      return { status: "error", message: "Підручник не знайдено." };
    }

    const scope = forFamily(material.owner_family_id, client);
    const { data: subject } = await scope.select("subjects", "id, name_uk").eq("id", subjectParsed.data).maybeSingle<{ id: string; name_uk: string }>();
    if (!subject) {
      return { status: "error", message: "Предмет не знайдено для цієї родини." };
    }

    const materialTitle = material.title ?? material.name;
    const result = await runLiteratureExtraction(scope, {
      familyId: material.owner_family_id,
      subjectId: subject.id,
      materialId: material.id,
      materialTitle,
      subjectName: subject.name_uk,
      grade: material.grade,
    });

    const active = result.topics.filter((t) => t.status === "active").length;
    const totalCostUsd = result.calls.reduce((sum, c) => sum + c.costUsd, 0);

    return {
      status: "ok",
      summary: {
        materialTitle,
        subjectName: subject.name_uk,
        groups: result.groups,
        topics: result.topics.map((t) => ({ topicNo: t.topicNo, status: t.status, failuresCount: t.failures.length })),
        active,
        needsReview: result.topics.length - active,
        driveWriteFailures: result.driveWriteFailures,
        totalCostUsd,
      },
    };
  } catch (e) {
    console.error(`runLiteratureExtractionAction failed: ${(e as Error).message}`);
    return { status: "error", message: uk.common.error };
  }
}
