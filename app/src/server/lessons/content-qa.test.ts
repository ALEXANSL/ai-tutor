import { describe, expect, it } from "vitest";
import {
  checkBlockContentQa,
  checkStepContentQa,
  checkVerbatimExcerptContentQa,
  checkVerbatimFidelity,
  contentQaFailureNoteUk,
  isVerbatimSubstring,
  looksComplete,
  looksEncodedCorrectly,
  normalizeForCompare,
} from "./content-qa";
import type { LessonBlockGenerated } from "./schema";

/**
 * ADR-034 unit tests: `content_qa`'s three check types. Same prod incident
 * (2026-09-28) that motivated the ADR — BUG-011 (mid-sentence truncation)
 * and BUG-046 (CP1251→Latin-1 mojibake) — is exercised directly here with
 * the actual reported strings where possible.
 */

describe("looksComplete (completeness check, generalizes truncateAtSentenceBoundary's heuristic)", () => {
  it("accepts a normal, sentence-terminated prose text", () => {
    expect(looksComplete("Це повне речення з крапкою.", "prose")).toBe(true);
  });

  it("rejects prose ending on a dangling preposition — the exact BUG-011 pattern ('...волі до')", () => {
    expect(looksComplete("Персонаж вижив завдяки незламній волі до", "prose")).toBe(false);
  });

  it("rejects prose ending on a dangling conjunction ('і', 'та', 'що')", () => {
    expect(looksComplete("Ми вивчили дроби і", "prose")).toBe(false);
    expect(looksComplete("Число складається з цілої частини та", "prose")).toBe(false);
    expect(looksComplete("Важливо розуміти, що", "prose")).toBe(false);
  });

  it("rejects prose ending on a bare comma or dash with no terminal punctuation", () => {
    expect(looksComplete("Спочатку додаємо чисельники,", "prose")).toBe(false);
    expect(looksComplete("Результат такий —", "prose")).toBe(false);
  });

  it("rejects text ending on a truncated number/code (digits, no letters, no terminator)", () => {
    expect(looksComplete("Учениця набрала 7", "prose")).toBe(false);
  });

  it("accepts a number ending in a real terminator (percent/period/paren) as complete", () => {
    expect(looksComplete("Досягнуто 70%", "prose")).toBe(true);
    expect(looksComplete("Дивись приклад (12)", "prose")).toBe(true);
  });

  it("kind='label': does not require terminal punctuation at all", () => {
    expect(looksComplete("Так", "label")).toBe(true);
    expect(looksComplete("1/2", "label")).toBe(true);
    expect(looksComplete("Синій кит", "label")).toBe(true);
  });

  it("kind='label': still rejects a dangling conjunction/preposition", () => {
    expect(looksComplete("Більше або", "label")).toBe(false);
  });

  it("kind='label': is lighter than 'prose' — allows a bare comma-ending label", () => {
    expect(looksComplete("Перший варіант,", "label")).toBe(true);
  });

  it("treats an empty/whitespace-only string as complete (nothing to judge)", () => {
    expect(looksComplete("", "prose")).toBe(true);
    expect(looksComplete("   ", "prose")).toBe(true);
  });

  it("accepts text ending on an ellipsis (truncateAtSentenceBoundary's own word-boundary fallback marker)", () => {
    expect(looksComplete("Довгий опис якогось явища…", "prose")).toBe(true);
  });
});

describe("looksEncodedCorrectly (encoding sanity + narrow BUG-046 signature)", () => {
  it("accepts normal Ukrainian prose", () => {
    expect(looksEncodedCorrectly("Дріб — це частина цілого, записана у вигляді m/n.").ok).toBe(true);
  });

  it("accepts legitimate math/physics symbols (², ³, °, %, +, −, ×, ÷, =)", () => {
    expect(looksEncodedCorrectly("Температура становить 20°C, об'єм — 5 м³, площа — 4 м².").ok).toBe(true);
  });

  it("BUG-046: rejects the exact reported mojibake ('л³тературно¿ мандр³вки')", () => {
    const res = looksEncodedCorrectly("Запрошення до л³тературно¿ мандрівки");
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/BUG-046/);
  });

  it("BUG-046: rejects ¿ landing between Cyrillic letters, not only ³", () => {
    const res = looksEncodedCorrectly("Це слово л¿тературне");
    expect(res.ok).toBe(false);
  });

  it("BUG-046: does NOT flag legitimate cubic/square units (см³, м³, дм³, мм²) — the exact false-positive risk the bug doc raised", () => {
    expect(looksEncodedCorrectly("Об'єм кубика — 8 см³.").ok).toBe(true);
    expect(looksEncodedCorrectly("Швидкість витрати 2 м³/с.").ok).toBe(true);
    expect(looksEncodedCorrectly("Площа поверхні 10 мм².").ok).toBe(true);
  });

  it("does NOT flag ³/¿ that are not adjacent to a Cyrillic letter in the same word (Latin/space/digit neighbor)", () => {
    expect(looksEncodedCorrectly("x³ + y² = 9, formula in Latin").ok).toBe(true);
  });

  it("rejects text with a high density of characters outside the expected range", () => {
    const junk = "Нормальний текст ".repeat(3) + "§±€¥₴¤※‰†‡¶©®™✓✗".repeat(3);
    expect(looksEncodedCorrectly(junk).ok).toBe(false);
  });

  it("tolerates a rare, isolated out-of-range character below the density threshold", () => {
    const longProse = "Це дуже довгий, абсолютно нормальний абзац українською мовою, ".repeat(10) + "€";
    expect(looksEncodedCorrectly(longProse).ok).toBe(true);
  });

  it("treats an empty string as ok", () => {
    expect(looksEncodedCorrectly("").ok).toBe(true);
  });
});

describe("verbatim-quote-vs-source fidelity", () => {
  it("normalizeForCompare collapses whitespace/newlines and trims", () => {
    expect(normalizeForCompare("  Рядок   з\n  пробілами  ")).toBe("Рядок з пробілами");
  });

  it("isVerbatimSubstring: true when the step text is a whitespace-normalized substring of the source", () => {
    const source = "Довгий абзац.\nДруге речення тут. Третє речення завершує думку.";
    expect(isVerbatimSubstring("Друге речення тут.", source)).toBe(true);
  });

  it("isVerbatimSubstring: ignores our own trailing ellipsis truncation marker", () => {
    const source = "Довге речення, яке буде обірване по межі слова тут і далі";
    expect(isVerbatimSubstring("Довге речення, яке буде обірване по межі слова…", source)).toBe(true);
  });

  it("isVerbatimSubstring: false when the text diverges from the source (corruption/mismatch)", () => {
    const source = "Правильний оригінальний текст підручника.";
    expect(isVerbatimSubstring("Змінений текст, якого немає в джерелі.", source)).toBe(false);
  });

  it("checkVerbatimFidelity returns null on a match, a failure on a mismatch", () => {
    const source = "Оригінальний текст джерела.";
    expect(checkVerbatimFidelity("Оригінальний текст джерела.", source)).toBeNull();
    const failure = checkVerbatimFidelity("Зовсім інший текст.", source);
    expect(failure).not.toBeNull();
    expect(failure!.code).toBe("fidelity");
  });

  it("checkVerbatimExcerptContentQa combines completeness + encoding + fidelity for one excerpt", () => {
    const source = "Це джерело, з якого братиметься уривок для перевірки.";
    expect(checkVerbatimExcerptContentQa("Це джерело, з якого братиметься уривок для перевірки.", source).ok).toBe(true);
    // Truncated mid-clause (ends on the dangling preposition "для").
    const bad = checkVerbatimExcerptContentQa("Це джерело, з якого братиметься уривок для", source);
    expect(bad.ok).toBe(false);
    expect(bad.failures.map((f) => f.code)).toContain("completeness");
  });
});

// --- Step/block level orchestration (normal AI-generation path) -----------

function slideBlock(textUk: string): LessonBlockGenerated {
  return {
    titleUk: "Тест",
    estimatedMinutes: 5,
    hookUk: "Гачок",
    visibleOutcomeUk: "Результат",
    techniquesUsed: ["retrieval_practice"],
    steps: [{ type: "slide", textUk, sourceRefs: [] }],
  };
}

describe("checkStepContentQa / checkBlockContentQa (per-field, per-step orchestration)", () => {
  it("passes a well-formed slide step with no failures", () => {
    const step = slideBlock("Це нормальне, завершене речення для дитини.").steps[0]!;
    expect(checkStepContentQa(step, 0)).toEqual([]);
  });

  it("flags a truncated slide.textUk with a completeness failure at the right field path", () => {
    const step = slideBlock("Персонаж вижив завдяки незламній волі до").steps[0]!;
    const failures = checkStepContentQa(step, 2);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stepIndex: 2, field: "textUk", code: "completeness" });
  });

  it("checks every field of a choice step: question, options, explanation, misconceptions", () => {
    const step: LessonBlockGenerated["steps"][number] = {
      type: "choice",
      questionUk: "Яка дріб більша, 1/2 чи", // truncated
      options: [
        { id: "a", textUk: "1/2" },
        { id: "b", textUk: "1/4", misconceptionUk: "Учні часто плутають знаменник і" }, // truncated
      ],
      correctOptionId: "a",
      explanationUk: "1/2 більша, бо чисельник відносно знаменника більший.",
      sourceRefs: [],
    };
    const failures = checkStepContentQa(step, 0);
    const fields = failures.map((f) => f.field);
    expect(fields).toContain("questionUk");
    expect(fields).toContain("options[1].misconceptionUk");
    expect(fields).not.toContain("options[0].textUk");
    expect(fields).not.toContain("explanationUk");
  });

  it("checks open step fields (question/expectedAnswer/rubric) and remediation retry variants", () => {
    const step: LessonBlockGenerated["steps"][number] = {
      type: "open",
      questionUk: "Що таке фотосинтез?",
      expectedAnswerUk: "Процес утворення",
      rubricUk: "Оцінюй за", // truncated
      remediation: { retryVariants: [{ questionUk: "Поясни ще раз, що", expectedAnswerUk: "коротка відповідь", rubricUk: "Повна відповідь." }] },
      sourceRefs: [],
    };
    const failures = checkStepContentQa(step, 0);
    const fields = failures.map((f) => f.field);
    expect(fields).toContain("rubricUk");
    expect(fields).toContain("remediation.retryVariants[0].questionUk");
  });

  it("checks an interactive step's fallbackTextUk", () => {
    const step: LessonBlockGenerated["steps"][number] = {
      type: "interactive",
      component: "drag_sort",
      v: 1,
      props: {},
      fallbackTextUk: "Якщо гра не завантажилась, онови сторінку і",
      sourceRefs: [],
    };
    const failures = checkStepContentQa(step, 0);
    expect(failures.map((f) => f.field)).toContain("fallbackTextUk");
  });

  it("checkBlockContentQa aggregates failures across every step with correct stepIndex", () => {
    const block: LessonBlockGenerated = {
      titleUk: "Тест",
      estimatedMinutes: 5,
      hookUk: "Гачок",
      visibleOutcomeUk: "Результат",
      techniquesUsed: ["retrieval_practice"],
      steps: [
        { type: "slide", textUk: "Нормальний перший крок.", sourceRefs: [] },
        { type: "slide", textUk: "Другий крок обривається на що", sourceRefs: [] },
      ],
    };
    const res = checkBlockContentQa(block);
    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0]!.stepIndex).toBe(1);
  });

  it("checkBlockContentQa.ok is true when every step passes", () => {
    const res = checkBlockContentQa(slideBlock("Все гаразд, крапка стоїть."));
    expect(res).toEqual({ ok: true, failures: [] });
  });
});

describe("contentQaFailureNoteUk (revision notes fed back into generateDraft)", () => {
  it("produces a distinct, actionable Ukrainian note per failure code", () => {
    const completeness = contentQaFailureNoteUk({ stepIndex: 1, field: "textUk", code: "completeness", reason: "текст виглядає обірваним" });
    const encoding = contentQaFailureNoteUk({ stepIndex: 2, field: "questionUk", code: "encoding", reason: "підозрілі символи" });
    expect(completeness).toContain("Крок 2");
    expect(completeness).toMatch(/Перегенеруй/);
    expect(encoding).toMatch(/Перефразуй/);
  });
});
