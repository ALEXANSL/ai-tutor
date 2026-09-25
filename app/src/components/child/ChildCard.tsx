export function ChildCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div
      className={`relative w-full ${wide ? "max-w-[600px]" : "max-w-[520px]"} rounded-[28px] bg-surface px-6 py-8 text-center shadow-[0_10px_40px_rgba(0,0,0,0.08)] sm:px-9 sm:py-10`}
    >
      {children}
    </div>
  );
}

export function StepDots({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <div className="mb-6 flex justify-center gap-2" role="img" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-2 rounded-full transition-all ${i < step ? "w-6 bg-primary" : "w-2 bg-line"}`}
        />
      ))}
    </div>
  );
}

export const primaryButton =
  "inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-[18px] bg-primary px-5 py-4 text-lg font-bold text-white transition hover:bg-primary-press active:scale-[0.98] disabled:opacity-60";
export const ghostButton =
  "inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-[18px] bg-surface-alt px-5 py-4 text-lg font-bold text-text active:scale-[0.98]";
export const textInput =
  "w-full rounded-2xl border-2 border-line bg-bg px-4 py-4 text-lg text-text outline-none focus:border-focus";
