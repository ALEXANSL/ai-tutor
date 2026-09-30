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
 * material lookup the CLI script does, reported back as a summary instead
 * of printed to a console the PO never opens.
 *
 * Mirrors the CLI script's own family resolution: the acting family is the
 * BOOK'S owner family (`materials.owner_family_id`), not necessarily the
 * calling parent's own family id — same as the CLI's `--family` default.
 * `requireParentAccess()` only gates "is this caller a parent at all", same
 * access level as the rest of `/parent/settings` (see
 * `ContentQaSweepPanel`'s doc for the precedent).
 *
 * 2026-09-30 (PO: "хто ж ці id буде пам'ятати"): the caller no longer
 * supplies `subjectId` by hand — every `materials` row already has its own
 * `subject_id`, so it's read straight off the chosen book instead of typed
 * separately. `listLiteratureCandidateMaterials` gives the settings page a
 * name-based picker instead of raw UUIDs.
 */

const UUID = z.string().uuid();

export interface LiteratureCandidateMaterial {
  id: string;
  title: string;
  subjectName: string | null;
}

/** Books with a subject attached, for the settings-page picker — no raw ids typed by hand. */
export async function listLiteratureCandidateMaterials(familyId: string): Promise<LiteratureCandidateMaterial[]> {
  const client = createServiceClient();
  const { data } = await client
    .from("materials")
    .select("id, title, name, subjects(name_uk)")
    .eq("owner_family_id", familyId)
    .order("title", { ascending: true })
    .returns<{ id: string; title: string | null; name: string; subjects: { name_uk: string } | null }[]>();
  return (data ?? []).map((m) => ({ id: m.id, title: m.title ?? m.name, subjectName: m.subjects?.name_uk ?? null }));
}

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

export async function runLiteratureExtractionAction(materialId: string): Promise<LiteratureExtractionState> {
  await requireParentAccess();

  const materialParsed = UUID.safeParse(materialId);
  if (!materialParsed.success) {
    return { status: "error", message: "Невірний ідентифікатор підручника." };
  }

  try {
    const client = createServiceClient();
    const { data: material, error: materialError } = await client
      .from("materials")
      .select("id, owner_family_id, subject_id, title, name, grade")
      .eq("id", materialParsed.data)
      .single<{ id: string; owner_family_id: string; subject_id: string | null; title: string | null; name: string; grade: number | null }>();
    if (materialError || !material) {
      return { status: "error", message: "Підручник не знайдено." };
    }
    if (!material.subject_id) {
      return { status: "error", message: "Ця книга не прив'язана до предмета — спершу вкажіть предмет на сторінці книги." };
    }

    const scope = forFamily(material.owner_family_id, client);
    const { data: subject } = await scope.select("subjects", "id, name_uk").eq("id", material.subject_id).maybeSingle<{ id: string; name_uk: string }>();
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
    if (result.groups === 0) {
      return { status: "error", message: "Ця книга ще не проіндексована (немає розпізнаних розділів/тексту) — спершу дочекайтесь індексації в «Моїх книгах»." };
    }

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
    const detail = (e as Error).message;
    console.error(`runLiteratureExtractionAction failed: ${detail}`);
    // Admin-only panel (requireParentAccess) — showing the real technical
    // reason (same as ContentQaSweepPanel/other admin panels today) beats
    // a bare "щось пішло не так" the PO already flagged as hiding root
    // causes he needs to see to know what to do next.
    return { status: "error", message: `${uk.common.error} (${detail})` };
  }
}
