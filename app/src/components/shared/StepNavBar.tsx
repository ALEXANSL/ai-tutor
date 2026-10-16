"use client";

/**
 * PO complaint 2026-10-16: "в підмодулях уроків різна кількість тексту, при
 * переході «далі» кнопки стрибають по екрану" — every course-v2 viewer
 * (math, both literatures) used to render its own "← Назад / Далі →" pair
 * right after the current step's content, so the buttons' on-screen
 * position moved up or down with however much text that one step had.
 *
 * Fixed to the bottom of the viewport (not the document flow), this bar
 * stays in the exact same screen position across every step, every lesson,
 * every subject — the "universal interface" Alex asked for, so a child
 * never has to re-find where "Далі" moved to. One shared component instead
 * of three near-identical copies (same duplication class the voice-mode
 * controls had before `VoiceModeControls.tsx`).
 *
 * The CALLER remains the single source of truth for the current step index
 * — this is pure, stateless chrome. `label` is caller-worded ("Екран X з Y"
 * for math/literature_v2, "Крок X з Y" for literature_v3) since those
 * viewers' content models differ; only the layout/positioning is shared.
 *
 * PO follow-up 2026-10-16: "відкрити підручник... можна перенести на нижню
 * панель і розмістити перед кнопкою далі, фокус буде — перед переходом далі
 * завжди можна відкрити оригінал" — the lesson-level "open textbook" button
 * (same page range for every step of one lesson) moves here, right before
 * "Далі →", via `middleControl`. Optional because not every viewer always
 * has a textbook/virtual-book link to offer (e.g. no linked textbook for
 * this subject yet).
 */
export function StepNavBar({
  label,
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  middleControl,
}: {
  label: string;
  onBack: () => void;
  onNext: () => void;
  backDisabled: boolean;
  nextDisabled: boolean;
  middleControl?: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-2 px-4 py-2.5">
        <button type="button" disabled={backDisabled} onClick={onBack} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          ← Назад
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-xs font-bold text-muted">{label}</p>
        {middleControl}
        <button type="button" disabled={nextDisabled} onClick={onNext} className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold disabled:opacity-40">
          Далі →
        </button>
      </div>
    </div>
  );
}

/** Reserves room at the bottom of the lesson page so `StepNavBar` (fixed,
 * outside document flow) never overlaps the last bit of step content. */
export const STEP_NAV_BAR_SPACER_CLASS = "pb-20";
