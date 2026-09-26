/**
 * Pure lesson orchestrator rules (ADR-007, docs/02 5.3). No I/O here on
 * purpose: every branching rule is a plain function, unit-tested directly;
 * `orchestrator.ts` is the only place that touches the database.
 */
// BUG-020: "manual_exit" is a deliberate "Вийти з уроку" tap, not an alarm or
// an interruption — reuses the very same pause/resume mechanism (BUG-008)
// so the current step is preserved and `resumeLessonSession` picks up right
// there, exactly like any other pause.
export type PauseReason = "manual_alert" | "manual_exit" | "air_alert" | "idle" | "network" | "budget_hard" | "parent_mode" | "break";
export type Verdict = "correct" | "partial" | "incorrect";
export type Channel = "choice" | "text" | "voice" | "photo";

export interface AttemptOutcome {
  verdict: Verdict;
  attemptNo: number;
}

export type BranchAction =
  /** US-6.3 КП-3: correct on the first try — skip the block's helper steps. */
  | { kind: "advance"; skipHelpers: boolean }
  /** US-6.3 КП-1: wrong — try an alternative explanation, then re-ask. */
  | { kind: "alt_explanation" }
  /** US-6.3 КП-2: two failures in a row on the same step — move on without it feeling like failure. */
  | { kind: "mark_for_review_and_advance" };

/** US-6.3: what happens after one attempt at a step, given prior attempts on it. */
export function decideBranch(attempt: AttemptOutcome, priorAttemptsOnStep: AttemptOutcome[]): BranchAction {
  if (attempt.verdict === "correct") {
    return { kind: "advance", skipHelpers: attempt.attemptNo === 1 };
  }
  const consecutiveFailures = 1 + countTrailingWhile([...priorAttemptsOnStep].reverse(), (a) => a.verdict !== "correct");
  if (consecutiveFailures >= 2) return { kind: "mark_for_review_and_advance" };
  return { kind: "alt_explanation" };
}

function countTrailingWhile<T>(reversed: T[], pred: (t: T) => boolean): number {
  let n = 0;
  for (const item of reversed) {
    if (!pred(item)) break;
    n++;
  }
  return n;
}

/**
 * US-16.5: 2 guesses in a row, or 3 wrong answers in a row across the block
 * (not just one step) → suggest a format change, never scolding.
 */
export function shouldSuggestFormatChange(recent: { guessFlag: boolean; verdict: Verdict }[]): boolean {
  const last = recent.slice(-3);
  const lastTwo = recent.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((r) => r.guessFlag)) return true;
  if (last.length === 3 && last.every((r) => r.verdict === "incorrect")) return true;
  return false;
}

/**
 * US-17.1 КП-3-style guess heuristic, scoped to what S3's branching needs
 * (full anti-guessing / points rules are US-17.1, slice S7): a choice
 * answered faster than a reading threshold, or a 3rd-or-later attempt at the
 * same choice question, looks like guessing rather than thinking.
 */
export function looksLikeGuess(channel: Channel, attemptNo: number, latencyMs: number | null, questionLength: number): boolean {
  if (channel !== "choice") return false;
  if (attemptNo >= 3) return true;
  const READ_MS_PER_CHAR = 15;
  const minReadMs = Math.min(2000, questionLength * READ_MS_PER_CHAR);
  return latencyMs != null && latencyMs < minReadMs;
}

/** US-16.4 КП-1: a friendly "are you there?" hint after `idleHintS` (налашт., default 60). */
export function idleHintDue(idleSeconds: number, idleHintS: number): boolean {
  return idleSeconds >= idleHintS;
}

/** US-16.4 КП-2: auto-pause after `idlePauseS` (налашт., default 180). */
export function idleAutoPauseDue(idleSeconds: number, idlePauseS: number): boolean {
  return idleSeconds >= idlePauseS;
}

/**
 * US-12.2 КП-1 (налашт., default 20 min): offer a break once continuous work
 * (since the lesson started, or since the last break) reaches the threshold.
 * Offered again after another full threshold of continuous work — КП-3.
 */
export function breakDue(secondsSinceBreak: number, breakAfterMinutes: number): boolean {
  return secondsSinceBreak >= breakAfterMinutes * 60;
}

/** US-6.7 КП-2: the lesson ends after the block in progress, once time is up — never mid-block. */
export function lessonTimeIsUp(activeSeconds: number, plannedMinutes: number): boolean {
  return activeSeconds >= plannedMinutes * 60;
}

/**
 * Where an interrupt (US-6.6 alarm, US-14.4 air-raid banner, offline, or a
 * hard budget stop — the last three are wired in later slices) takes the
 * session: always `paused`, current step preserved (docs/02 5.2, 5.3).
 */
export function pauseFor(reason: PauseReason): { status: "paused"; pause_reason: PauseReason } {
  return { status: "paused", pause_reason: reason };
}

/** US-6.5 КП-3: resuming after more than 24h offers a short reminder slide first. */
export function needsResumeReminder(pausedAt: Date, resumedAt: Date, thresholdHours = 24): boolean {
  return resumedAt.getTime() - pausedAt.getTime() >= thresholdHours * 60 * 60 * 1000;
}
