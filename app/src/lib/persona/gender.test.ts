import { describe, expect, it } from "vitest";
import familyDefaults from "@config/family-defaults.json";
import { uk } from "@/i18n/uk";
import { genderOfSuggestedName, gendered, parseTutorGender, resolveTutorGender } from "./gender";

const options = familyDefaults.tutorNameOptions;

describe("genderOfSuggestedName (BUG-002)", () => {
  it("returns the group of a suggested name", () => {
    expect(genderOfSuggestedName(options, "Ліра")).toBe("f");
    expect(genderOfSuggestedName(options, "Мирон")).toBe("m");
    expect(genderOfSuggestedName(options, "Остап")).toBe("m");
    expect(genderOfSuggestedName(options, "Ярема")).toBe("m");
  });
  it("returns null for a name that is not on the list", () => {
    expect(genderOfSuggestedName(options, "Максим")).toBeNull();
  });
});

describe("resolveTutorGender (US-1.7 KP-4, KP-10)", () => {
  it("uses the name gender while no voice is chosen (S0..S11)", () => {
    expect(resolveTutorGender({ voiceGender: null, nameGender: "m" })).toBe("m");
    expect(resolveTutorGender({ nameGender: "f" })).toBe("f");
  });
  it("lets the chosen voice win once it exists (S12)", () => {
    expect(resolveTutorGender({ voiceGender: "f", nameGender: "m" })).toBe("f");
    expect(resolveTutorGender({ voiceGender: "m", nameGender: "f" })).toBe("m");
  });
  it("defaults to female (D-18)", () => {
    expect(resolveTutorGender({})).toBe("f");
  });
});

describe("gendered / parseTutorGender", () => {
  it("picks the role noun for the honest 'I am AI' intro", () => {
    expect(gendered("f", uk.ai.roleNoun)).toBe("ШІ-помічниця");
    expect(gendered("m", uk.ai.roleNoun)).toBe("ШІ-помічник");
    expect(uk.child.onboarding.aiIntro.body(gendered("m", uk.ai.roleNoun))).toBe(
      "Я — ШІ-помічник, не людина. Я допоможу тобі вчитися.",
    );
  });
  it("parses form values safely", () => {
    expect(parseTutorGender("m")).toBe("m");
    expect(parseTutorGender("f")).toBe("f");
    expect(parseTutorGender("")).toBe("f");
    expect(parseTutorGender(null)).toBe("f");
  });
});
