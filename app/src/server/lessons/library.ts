import "server-only";
import { forFamily } from "@/server/db/family-scope";
import { REVIEW_CRITERION_LABELS_UK, type ReviewCriterion } from "./pedagogy";

/**
 * Parent cabinet read models for the lesson library (US-6.10, US-19.1):
 * the "methodical passport" card and its backing review history. Never
 * shown to the child (US-6.10 КП-4) — these are `requireParentAccess()`
 * pages only.
 */
export interface PedagogyPassport {
  goalUk: string;
  hookUk: string;
  visibleOutcomeUk: string;
  techniques: { key: string; whyUk: string }[];
  misconceptionsUk: string[];
  comprehensionChecksUk: string[];
  reviewStatus: "first_pass" | "revised" | "needs_review";
}

export interface LibraryCard {
  id: string;
  title: string;
  status: string;
  estimatedMinutes: number | null;
  pedagogy: PedagogyPassport | null;
  childFeedback: { interesting: number; normal: number; boring: number };
  createdAt: string;
}

interface LibraryItemRow {
  id: string;
  title: string;
  status: string;
  estimated_minutes: number | null;
  pedagogy: PedagogyPassport | null;
  child_feedback: { interesting?: number; normal?: number; boring?: number } | null;
  created_at: string;
}

function toCard(row: LibraryItemRow): LibraryCard {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    estimatedMinutes: row.estimated_minutes,
    pedagogy: row.pedagogy && Object.keys(row.pedagogy).length > 0 ? row.pedagogy : null,
    childFeedback: { interesting: row.child_feedback?.interesting ?? 0, normal: row.child_feedback?.normal ?? 0, boring: row.child_feedback?.boring ?? 0 },
    createdAt: row.created_at,
  };
}

/** US-6.10 КП-1, DoD п.11: every saved block of a topic, newest first, with its passport and status. */
export async function listLibraryCardsForTopic(familyId: string, topicId: string): Promise<LibraryCard[]> {
  const { data } = await forFamily(familyId)
    .select("library_items", "id, title, status, estimated_minutes, pedagogy, child_feedback, created_at")
    .eq("topic_id", topicId)
    .eq("kind", "block")
    .order("created_at", { ascending: false })
    .returns<LibraryItemRow[]>();
  return (data ?? []).map(toCard);
}

export interface ReviewRecordView {
  iteration: number;
  provider: string;
  model: string;
  verdict: "approved" | "revise" | "rejected";
  scores: Partial<Record<ReviewCriterion, number>>;
  notes: string | null;
  createdAt: string;
}

export interface LibraryItemDetail {
  card: LibraryCard;
  subjectId: string;
  topicId: string;
  reviews: ReviewRecordView[];
}

/** One block's full passport + independent-review history (US-6.11 КП-3). */
export async function loadLibraryCardDetail(familyId: string, itemId: string): Promise<LibraryItemDetail | null> {
  const scope = forFamily(familyId);
  const { data: item } = await scope
    .select("library_items", "id, title, status, estimated_minutes, pedagogy, child_feedback, created_at, subject_id, topic_id")
    .eq("id", itemId)
    .maybeSingle<LibraryItemRow & { subject_id: string; topic_id: string }>();
  if (!item) return null;
  const { data: reviews } = await scope
    .select("library_item_reviews", "iteration, provider, model, verdict, scores, notes, created_at")
    .eq("library_item_id", itemId)
    .order("iteration")
    .returns<{ iteration: number; provider: string; model: string; verdict: ReviewRecordView["verdict"]; scores: Partial<Record<ReviewCriterion, number>>; notes: string | null; created_at: string }[]>();
  return {
    card: toCard(item),
    subjectId: item.subject_id,
    topicId: item.topic_id,
    reviews: (reviews ?? []).map((r) => ({ iteration: r.iteration, provider: r.provider, model: r.model, verdict: r.verdict, scores: r.scores, notes: r.notes, createdAt: r.created_at })),
  };
}

export { REVIEW_CRITERION_LABELS_UK };
