import { describe, expect, it } from "vitest";
import { matchVideoSupplement } from "./videoSupplementMatch";
const first = { id: "v16", topicId: "legacy-16", topicTitle: "§ 16. Цивілізації Сходу", sizeBytes: 10, createdAt: "" };
describe("non-mutating video supplement match", () => {
  it("uses exact topic attachment ahead of title fallback", () => { expect(matchVideoSupplement([first], first.topicId, "Changed title")).toBe(first); });
  it("recovers an old attachment by unique full title despite punctuation/case", () => { expect(matchVideoSupplement([first], "imported-16", "§ 16 — ЦИВІЛІЗАЦІЇ СХОДУ")).toBe(first); });
  it("never guesses by the paragraph number or fuzzy keywords", () => { expect(matchVideoSupplement([first], "imported", "§ 16. Географічні відкриття")).toBeNull(); });
  it("does not guess between duplicate-title attachments", () => { expect(matchVideoSupplement([first, { ...first, id: "other", topicId: "other" }], "new", first.topicTitle)).toBeNull(); });
});
