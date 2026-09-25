import { uk } from "@/i18n/uk";

/** S3 restriction: the lesson is visible only via `requireParentAccess()` (docs/STATUS.md). */
export function ParentOnlyBadge() {
  const t = uk.child.lesson;
  return (
    <div className="mx-6 mt-4 rounded-2xl border border-line bg-surface-alt px-4 py-2.5 text-sm font-bold" title={t.parentOnlyHint}>
      {t.parentOnlyBadge}
    </div>
  );
}
