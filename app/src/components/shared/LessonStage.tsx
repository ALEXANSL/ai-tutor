import type { ReactNode, Ref, UIEventHandler } from "react";

/** Same viewport frame for explanation, reading, biography and quiz steps. */
export function LessonStage({ title, eyebrow, actions, children, scrollRef, onScroll }: {
  title: string; eyebrow?: string; actions?: ReactNode; children: ReactNode;
  scrollRef?: Ref<HTMLDivElement>; onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  return <section className="lit-v3-step lesson-stage">
    <header className="lesson-stage-header">
      {eyebrow && <p className="course-eyebrow">{eyebrow}</p>}
      <h3>{title}</h3>
      {actions && <div className="lesson-stage-actions">{actions}</div>}
    </header>
    <div ref={scrollRef} onScroll={onScroll} className="lesson-stage-body" role="region" aria-label={title} tabIndex={0}>{children}</div>
  </section>;
}
