import { describe, expect, it } from "vitest";
import {
  decideBranch,
  idleAutoPauseDue,
  idleHintDue,
  lessonTimeIsUp,
  looksLikeGuess,
  needsResumeReminder,
  shouldSuggestFormatChange,
} from "./state-machine";

describe("decideBranch (US-6.3, docs/02 5.3)", () => {
  it("advances and skips helpers on a first-try correct answer (КП-3)", () => {
    expect(decideBranch({ verdict: "correct", attemptNo: 1 }, [])).toEqual({ kind: "advance", skipHelpers: true });
  });

  it("does not skip helpers on a correct answer after a retry", () => {
    expect(decideBranch({ verdict: "correct", attemptNo: 2 }, [{ verdict: "incorrect", attemptNo: 1 }])).toEqual({
      kind: "advance",
      skipHelpers: false,
    });
  });

  it("offers an alternative explanation on the first wrong answer (КП-1)", () => {
    expect(decideBranch({ verdict: "incorrect", attemptNo: 1 }, [])).toEqual({ kind: "alt_explanation" });
  });

  it("marks for review and moves on after two consecutive failures on the same step (КП-2)", () => {
    const prior = [{ verdict: "incorrect" as const, attemptNo: 1 }];
    expect(decideBranch({ verdict: "incorrect", attemptNo: 2 }, prior)).toEqual({ kind: "mark_for_review_and_advance" });
  });

  it("a correct answer resets the failure streak for a later wrong one", () => {
    const prior = [
      { verdict: "incorrect" as const, attemptNo: 1 },
      { verdict: "correct" as const, attemptNo: 2 },
    ];
    // A fresh attempt after a correct one — only counts the immediate trailing failures.
    expect(decideBranch({ verdict: "incorrect", attemptNo: 3 }, prior)).toEqual({ kind: "alt_explanation" });
  });
});

describe("shouldSuggestFormatChange (US-16.5)", () => {
  it("suggests a change after two guesses in a row", () => {
    const recent = [
      { guessFlag: false, verdict: "correct" as const },
      { guessFlag: true, verdict: "incorrect" as const },
      { guessFlag: true, verdict: "incorrect" as const },
    ];
    expect(shouldSuggestFormatChange(recent)).toBe(true);
  });

  it("suggests a change after three wrong answers in a row", () => {
    const recent = [
      { guessFlag: false, verdict: "incorrect" as const },
      { guessFlag: false, verdict: "incorrect" as const },
      { guessFlag: false, verdict: "incorrect" as const },
    ];
    expect(shouldSuggestFormatChange(recent)).toBe(true);
  });

  it("does not suggest a change on ordinary progress", () => {
    const recent = [
      { guessFlag: false, verdict: "correct" as const },
      { guessFlag: false, verdict: "incorrect" as const },
      { guessFlag: false, verdict: "correct" as const },
    ];
    expect(shouldSuggestFormatChange(recent)).toBe(false);
  });
});

describe("looksLikeGuess", () => {
  it("flags a very fast choice answer to a long question", () => {
    expect(looksLikeGuess("choice", 1, 300, 80)).toBe(true);
  });
  it("does not flag a slow, considered answer", () => {
    expect(looksLikeGuess("choice", 1, 5000, 80)).toBe(false);
  });
  it("flags the 3rd+ attempt at the same choice question regardless of latency", () => {
    expect(looksLikeGuess("choice", 3, 9000, 80)).toBe(true);
  });
  it("never flags open-text or interactive answers (only choice, per US-17.1 КП-3 phrasing)", () => {
    expect(looksLikeGuess("text", 1, 100, 80)).toBe(false);
  });
});

describe("idle / lesson timing (US-16.4, US-6.7)", () => {
  it("hint at 60s, auto-pause at 180s (defaults)", () => {
    expect(idleHintDue(59, 60)).toBe(false);
    expect(idleHintDue(60, 60)).toBe(true);
    expect(idleAutoPauseDue(179, 180)).toBe(false);
    expect(idleAutoPauseDue(180, 180)).toBe(true);
  });

  it("a 30-minute lesson ends only once 1800 active seconds have passed", () => {
    expect(lessonTimeIsUp(1799, 30)).toBe(false);
    expect(lessonTimeIsUp(1800, 30)).toBe(true);
  });

  it("resuming after 24h+ needs a reminder slide (КП-3)", () => {
    const paused = new Date("2026-01-01T10:00:00Z");
    expect(needsResumeReminder(paused, new Date("2026-01-02T09:59:00Z"))).toBe(false);
    expect(needsResumeReminder(paused, new Date("2026-01-02T10:00:01Z"))).toBe(true);
  });
});
