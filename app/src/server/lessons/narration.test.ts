import { describe, expect, it } from "vitest";
import { readableTextForStep } from "./narration";

describe("readableTextForStep (US-6.16 КП-5, ADR-025)", () => {
  it("reads a slide's text and example", () => {
    expect(readableTextForStep({ type: "slide", content: { textUk: "Дроби.", exampleUk: "6/8 = 3/4." } })).toBe("Дроби.. 6/8 = 3/4.");
  });

  it("reads a choice step's question and options, in order", () => {
    const text = readableTextForStep({
      type: "choice",
      content: { questionUk: "Скороти дріб", options: [{ textUk: "4/6" }, { textUk: "2/3" }] },
    });
    expect(text).toBe("Скороти дріб. 4/6. 2/3");
  });

  it("reads an open step's question", () => {
    expect(readableTextForStep({ type: "open", content: { questionUk: "Чому 8/12 = 2/3?" } })).toBe("Чому 8/12 = 2/3?");
  });

  it("returns an empty string for a step with nothing readable (e.g. a pure interactive step)", () => {
    expect(readableTextForStep({ type: "interactive", content: {} })).toBe("");
  });
});
