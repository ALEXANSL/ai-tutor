/** Small shared building blocks for cabinet pages (mockups 10–17). */
export function PageTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2.5">
      <h1 className="text-[22px] font-bold">{children}</h1>
      {action}
    </div>
  );
}

export function Panel({ title, children, id }: { title?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-4 rounded-2xl border border-p-line bg-p-surface px-5 py-4.5">
      {title && <h2 className="mb-3.5 text-[15px] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export const parentInput =
  "min-h-11 w-full rounded-xl border border-p-line bg-p-bg px-3 text-[15px] text-p-text outline-none focus:border-p-primary";
export const parentButton =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white disabled:opacity-60";
