import { describe, expect, it } from "vitest";
import { validateNickname, validateTutorName, normalizeTutorName } from "./validation";
import { personaWordlists } from "./wordlists";

const wordlists = personaWordlists;

describe("validateNickname (US-1.6 KP-1)", () => {
  it.each(["Зірочка", "Зо", "Кіт-Мурчик", "Star 2024", "Лисичка 🦊", "Ромашка_7"])("accepts %s", (nick) => {
    expect(validateNickname(nick)).toEqual({ ok: true, value: nick });
  });

  it("trims and collapses whitespace", () => {
    expect(validateNickname("  Зір   очка ")).toEqual({ ok: true, value: "Зір очка" });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["З", "too_short"],
    ["Дуже-дуже-довге-прізвисько", "too_long"],
    ["zirka@gmail", "at_sign"],
    ["@зірка", "at_sign"],
    ["Зірка12345", "long_digits"],
    ["067 123 45 67", "long_digits"],
    ["(067)-12-3", "long_digits"],
    ["https://x", "link"],
    ["www.zirka", "link"],
    ["зірка.com", "link"],
    ["<b>Зірка</b>", "invalid_chars"],
  ] as const)("rejects %j with %s", (nick, error) => {
    expect(validateNickname(nick)).toEqual({ ok: false, error });
  });

  it("allows up to 4 digits in a row", () => {
    expect(validateNickname("Зірка 2026").ok).toBe(true);
  });

  it("counts emoji as single characters", () => {
    expect(validateNickname("🦊🦊").ok).toBe(true);
    expect(validateNickname("🦊").ok).toBe(false);
  });
});

describe("validateTutorName (US-1.7 KP-3, PM-22)", () => {
  const check = (name: string, nickname: string | null = "Зірочка") =>
    validateTutorName(name, { nickname, wordlists });

  it.each(["Ліра", "Веснянка", "Зоряна", "Мар’яна", "Анна-Марія", "Luna", "Зоряна Ліра"])("accepts %s", (name) => {
    expect(check(name).ok).toBe(true);
  });

  it("normalizes apostrophes to the Ukrainian typographic one", () => {
    expect(normalizeTutorName("Мар'яна")).toBe("Мар’яна");
    expect(check("Марʼяна")).toEqual({ ok: true, value: "Мар’яна" });
  });

  it.each([
    ["", "empty"],
    ["Л", "too_short"],
    ["Надзвичайнодовгеімʼярепетитора", "too_long"],
    ["Ліра2", "invalid_chars"],
    ["Ліра!", "invalid_chars"],
    ["ліра@x", "invalid_chars"],
    ["http", "ok"],
    ["Ліра  -Зоря", "invalid_chars"],
    ["Ёлка", "invalid_chars"],
  ] as const)("format: %j -> %s", (name, expected) => {
    const result = check(name);
    if (expected === "ok") expect(result.ok).toBe(true);
    else expect(result).toEqual({ ok: false, error: expected });
  });

  it.each(["Мама", "мамочка", "Тато", "Бабуся", "Дідусь", "Сестричка", "Mom", "Daddy", "Друг", "Подружка"])(
    "rejects kinship word %s",
    (name) => {
      expect(check(name)).toEqual({ ok: false, error: "kinship" });
    },
  );

  it.each(["Найкращий друг", "найкраща подруга", "Best Friend", "Мама-Ліра", "Ліра мама"])(
    "rejects kinship phrase or part %s",
    (name) => {
      expect(check(name)).toEqual({ ok: false, error: "kinship" });
    },
  );

  it("folds Latin look-alike letters (mixed-script bypass)", () => {
    // "мама" typed with Latin "a"
    expect(check("мaмa")).toEqual({ ok: false, error: "kinship" });
  });

  it.each(["Дурень", "Ідіотка", "Stupid", "Смертник"])("rejects inappropriate word %s", (name) => {
    expect(check(name)).toEqual({ ok: false, error: "inappropriate" });
  });

  it("does not flag names that merely contain a kinship word inside", () => {
    expect(check("Тамара").ok).toBe(true);
    expect(check("Мамай").ok).toBe(true);
    expect(check("Братислава").ok).toBe(true);
  });

  it("rejects a name equal to the child's nickname (case/space-insensitive)", () => {
    expect(check("зірочка")).toEqual({ ok: false, error: "same_as_nickname" });
    expect(check("Зір очка", "Зірочка")).toEqual({ ok: false, error: "same_as_nickname" });
    expect(check("Зірочка", null).ok).toBe(true);
  });
});
