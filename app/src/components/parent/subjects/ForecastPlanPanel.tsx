import { uk } from "@/i18n/uk";
import type { ForecastPlan, PlanTopicNode } from "@/server/subjects/plan";
import { Panel } from "@/app/parent/ui";

function TopicRow({ topic, tone }: { topic: PlanTopicNode; tone: "prereq" | "current" | "next" }) {
  const t = uk.parent.subjects.detail;
  const dot = tone === "current" ? "bg-p-primary" : tone === "prereq" ? "bg-p-warn" : "bg-p-success";
  return (
    <div className="flex items-center justify-between gap-3 border-b border-p-line py-2 last:border-b-0">
      <span className="flex items-center gap-2 text-[14px]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        {topic.title}
        {tone === "current" && <span className="rounded-full bg-p-primary/15 px-2 py-0.5 text-[11px] font-bold text-p-primary">{t.current}</span>}
      </span>
      {topic.pageFrom != null && <span className="shrink-0 text-[12px] text-p-muted">{t.pages(topic.pageFrom, topic.pageTo)}</span>}
    </div>
  );
}

/** US-3.2 KP-1: prerequisites to check → current topic → next topics, with textbook page links. */
export function ForecastPlanPanel({ plan }: { plan: ForecastPlan }) {
  const t = uk.parent.subjects.plan;
  return (
    <Panel title={t.title}>
      <p className="-mt-2 mb-3.5 text-xs text-p-muted">{t.subtitle}</p>

      <h3 className="mb-1.5 text-[12px] font-bold uppercase text-p-muted">{t.prereqTitle}</h3>
      {plan.prerequisites.length === 0 ? (
        <p className="mb-3 text-[13px] text-p-muted">{t.prereqEmpty}</p>
      ) : (
        <div className="mb-3">
          {plan.prerequisites.map((tp) => (
            <TopicRow key={tp.id} topic={tp} tone="prereq" />
          ))}
        </div>
      )}

      <h3 className="mb-1.5 text-[12px] font-bold uppercase text-p-muted">{t.currentTitle}</h3>
      <div className="mb-3">
        <TopicRow topic={plan.currentTopic} tone="current" />
      </div>

      <h3 className="mb-1.5 text-[12px] font-bold uppercase text-p-muted">{t.nextTitle}</h3>
      {plan.next.length === 0 ? (
        <p className="text-[13px] text-p-muted">{t.nextEmpty}</p>
      ) : (
        <div>
          {plan.next.map((tp) => (
            <TopicRow key={tp.id} topic={tp} tone="next" />
          ))}
        </div>
      )}
    </Panel>
  );
}
