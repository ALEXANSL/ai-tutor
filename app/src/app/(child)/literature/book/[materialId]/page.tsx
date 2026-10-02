import Link from "next/link";
import { notFound } from "next/navigation";
import { requireChild } from "@/server/auth/guards";
import { listLiteratureLessons } from "@/server/lessons/literatureView";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S33 (PO decision 2026-09-30) — minimal list of every extracted topic for
 * one book, so the demo has a discovery path (not just direct lesson URLs).
 * Reads via the service-role `forFamily` scope (same pattern every other
 * server-rendered page in this app uses) so a `needs_review` topic is still
 * listed here, visibly marked, for the parent/PO to check.
 */
export default async function LiteratureBookIndexPage({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
  if (!UUID.test(materialId)) notFound();
  const { ctx } = await requireChild();
  const lessons = await listLiteratureLessons(ctx.familyId, materialId);

  return (
    <main style={{ padding: 24 }}>
      <h1>Теми</h1>
      <p>
        <Link href={`/book/${materialId}`}>📖 Читати оригінал книги (PDF)</Link>
      </p>
      {lessons.length === 0 && <p>Ще немає жодної згенерованої теми для цієї книги.</p>}
      <ol>
        {lessons.map((l) => (
          <li key={l.id}>
            <Link href={`/literature/${l.id}`}>
              Тема {l.topicNo}. {l.title}
            </Link>
            {l.status === "needs_review" && <span> — потребує перевірки</span>}
          </li>
        ))}
      </ol>
    </main>
  );
}
