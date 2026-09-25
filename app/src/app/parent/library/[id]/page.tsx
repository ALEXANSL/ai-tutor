import Link from "next/link";
import { notFound } from "next/navigation";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { loadLibraryCardDetail } from "@/server/lessons/library";
import { REVIEW_CRITERION_LABELS_UK } from "@/server/lessons/pedagogy";
import { PageTitle, Panel } from "../../ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The "methodical passport" card (US-6.10, DoD п.11): goal, chosen P-P
 * techniques with their "why here", misconceptions covered, comprehension
 * checks, and the independent-review history behind the block's status
 * (US-6.11 КП-3). Parent-only — never shown to the child (US-6.10 КП-4).
 */
export default async function LibraryItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { familyId } = await requireParentAccess();
  const detail = await loadLibraryCardDetail(familyId, id);
  if (!detail) notFound();
  const t = uk.parent.subjects.library;
  const { card } = detail;

  return (
    <>
      <PageTitle>
        <Link href={`/parent/subjects/${detail.subjectId}`} className="mb-1 block text-[13px] font-normal text-p-primary">
          {t.back}
        </Link>
        {card.title}
      </PageTitle>

      {card.pedagogy ? (
        <Panel title={t.passportTitle}>
          <dl className="grid gap-3 text-[14px]">
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.goal}</dt>
              <dd className="text-p-text">{card.pedagogy.goalUk}</dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.hook}</dt>
              <dd className="text-p-text">{card.pedagogy.hookUk}</dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.outcome}</dt>
              <dd className="text-p-text">{card.pedagogy.visibleOutcomeUk}</dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.techniques}</dt>
              <dd>
                <ul className="grid gap-1">
                  {card.pedagogy.techniques.map((tech) => (
                    <li key={tech.key} className="text-p-text">
                      <span className="font-semibold">{tech.key}</span> — {tech.whyUk}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.misconceptions}</dt>
              <dd>
                <ul className="list-disc pl-5 text-p-text">
                  {card.pedagogy.misconceptionsUk.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.comprehensionChecks}</dt>
              <dd>
                <ul className="list-disc pl-5 text-p-text">
                  {card.pedagogy.comprehensionChecksUk.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </dd>
            </div>
            <div>
              <dt className="mb-0.5 text-[12px] font-bold text-p-muted">{t.childFeedback}</dt>
              <dd className="text-p-text">
                {card.childFeedback.interesting + card.childFeedback.normal + card.childFeedback.boring === 0
                  ? t.childFeedbackNone
                  : `${card.childFeedback.interesting}🤩 · ${card.childFeedback.normal}🙂 · ${card.childFeedback.boring}😐`}
              </dd>
            </div>
          </dl>
        </Panel>
      ) : (
        <Panel title={t.passportTitle}>
          <p className="text-[13px] text-p-muted">{t.empty}</p>
        </Panel>
      )}

      <Panel title={t.reviewHistory}>
        <ul className="grid gap-3">
          {detail.reviews.map((r) => (
            <li key={r.iteration} className="rounded-xl border border-p-line bg-p-bg px-3.5 py-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-bold">{t.reviewIteration(r.iteration)}</span>
                <span className="text-[12px] font-bold text-p-muted">{t.reviewVerdict[r.verdict]}</span>
              </div>
              <p className="mb-1.5 text-[12px] text-p-muted">
                {r.provider} · {r.model}
              </p>
              <ul className="mb-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[12px] text-p-text">
                {Object.entries(r.scores).map(([k, v]) => (
                  <li key={k}>
                    {REVIEW_CRITERION_LABELS_UK[k as keyof typeof REVIEW_CRITERION_LABELS_UK] ?? k}: {v}/2
                  </li>
                ))}
              </ul>
              {r.notes && <p className="whitespace-pre-line text-[13px] text-p-text">{r.notes}</p>}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
