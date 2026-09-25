import { describe, expect, it } from "vitest";
import { personaWordlists } from "@/lib/persona/wordlists";
import familyDefaults from "@config/family-defaults.json";
import {
  canChildEdit,
  planNicknameChange,
  planTutorNameChange,
  resolveTutorNameChoice,
} from "./plan";

const options = familyDefaults.tutorNameOptions;
const ctx = { nickname: "Зірочка", wordlists: personaWordlists };

describe("planNicknameChange (US-1.6 KP-3, PM-12)", () => {
  it("logs the change and notifies the parent when the child picks a nickname", () => {
    expect(planNicknameChange(null, "Зірочка", "child")).toEqual({
      update: true,
      change: { field: "nickname", old_value: null, new_value: "Зірочка", changed_by: "child" },
      notification: { type: "nickname_changed", severity: "normal", payload: { nickname: "Зірочка", previous: null } },
    });
  });
  it("does not notify the parent about the parent's own edit", () => {
    expect(planNicknameChange("Зірочка", "Зірка", "parent").notification).toBeUndefined();
  });
  it("is a no-op when nothing changed", () => {
    expect(planNicknameChange("Зірочка", "Зірочка", "child")).toEqual({ update: false });
  });
});

describe("planTutorNameChange (US-1.7 KP-11)", () => {
  it("notifies the parent that the persona changed", () => {
    expect(planTutorNameChange("Ліра", "Зоряна", "child").notification).toEqual({
      type: "persona_changed",
      severity: "normal",
      payload: { field: "name", value: "Зоряна", previous: "Ліра" },
    });
  });
});

describe("resolveTutorNameChoice (US-1.7 KP-2, KP-3)", () => {
  it("accepts a suggested name without further checks", () => {
    expect(resolveTutorNameChoice({ choice: "suggested:Ліра", custom: "" }, options, ctx)).toEqual({
      ok: true,
      name: "Ліра",
      source: "suggested",
    });
  });
  it("rejects a forged 'suggested' value that is not on the list", () => {
    expect(resolveTutorNameChoice({ choice: "suggested:Мама", custom: "" }, options, ctx)).toEqual({
      ok: false,
      error: "not_suggested",
    });
  });
  it("accepts a valid custom name", () => {
    expect(resolveTutorNameChoice({ choice: "custom", custom: " Мар'яна " }, options, ctx)).toEqual({
      ok: true,
      name: "Мар’яна",
      source: "custom",
    });
  });
  it("rejects kinship / inappropriate custom names and notifies the parent", () => {
    const r = resolveTutorNameChoice({ choice: "custom", custom: "Мама" }, options, ctx);
    expect(r).toMatchObject({ ok: false, error: "kinship", notifyParent: { type: "tutor_name_rejected" } });
    const r2 = resolveTutorNameChoice({ choice: "custom", custom: "Дурень" }, options, ctx);
    expect(r2).toMatchObject({ ok: false, error: "inappropriate", notifyParent: { payload: { reason: "inappropriate" } } });
  });
  it("does not bother the parent with plain typos", () => {
    const r = resolveTutorNameChoice({ choice: "custom", custom: "Л" }, options, ctx);
    expect(r).toEqual({ ok: false, error: "too_short", notifyParent: undefined });
  });
  it("rejects the child's own nickname as the tutor name", () => {
    expect(resolveTutorNameChoice({ choice: "custom", custom: "зірочка" }, options, ctx)).toMatchObject({
      ok: false,
      error: "same_as_nickname",
    });
  });
});

describe("canChildEdit (PM-23)", () => {
  it("defaults to allowed and respects the parent's switch", () => {
    expect(canChildEdit(undefined, "name")).toBe(true);
    expect(canChildEdit({ name: false, voice: false, avatar: false }, "name")).toBe(false);
  });
});
