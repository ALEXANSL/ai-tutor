import { expect, it } from "vitest";
import { sourceParagraphs, preparedManuscript, splitAudioText, audioSegmentKey } from "./text";
import { narrative } from "./__fixtures__/part";
it("preserves original dialogues/poetry and omits only referenced technical paragraphs", () => {
  const source = sourceParagraphs([{ page: 23, locator: null, text: `23\n\n${narrative}\n\nМал. 2. Острів` }]);
  const p = preparedManuscript(source, { omitted: [{ id: 0, reason: "page_number" }, { id: 3, reason: "illustration_caption" }], notes: "Текст не змінено" }, true);
  expect(p.text).toBe(narrative); expect(p.omitted).toHaveLength(2);
});
it("never removes an invented ID, duplicate or meaningful numeric paragraph", () => {
  const source = [{ id: 0, page: 1, text: narrative }];
  for (const omitted of [[{ id: 55, reason: "running_header" }], [{ id: 0, reason: "page_number" }], [{ id: 0, reason: "running_header" }, { id: 0, reason: "running_header" }]]) expect(() => preparedManuscript(source, { omitted, notes: "" }, true)).toThrow();
});
it("refuses a model deleting a long passage or most of the source", () => {
  expect(() => preparedManuscript([{ id: 0, page: 1, text: narrative.repeat(3) }], { omitted: [{ id: 0, reason: "running_header" }], notes: "" }, true)).toThrow();
});
it("keeps repeated literary refrains and exact content when nothing is excluded", () => {
  const s = sourceParagraphs([{ page: 1, locator: null, text: `${narrative}\n\n${narrative}` }]);
  expect(preparedManuscript(s, { omitted: [], notes: "" }, true).text).toBe(`${narrative}\n\n${narrative}`);
});
it("splits every character exactly once within TTS bounds including emoji and long words", () => {
  for (const text of [narrative.repeat(80), "абв".repeat(6000), "🙂".repeat(4001), `Перший.\n\n${narrative.repeat(40)}`]) {
    const parts = splitAudioText(text); expect(parts.join("")).toBe(text); expect(parts.every(p => p.length <= 2800)).toBe(true); expect(parts.every(p => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p))).toBe(true);
  }
});
it("keys exact full text and voice/model with no 4000-char truncation", () => {
  expect(audioSegmentKey(narrative, "tts-1-hd", "nova")).not.toBe(audioSegmentKey(narrative, "tts-1-hd", "onyx"));
  expect(audioSegmentKey("a".repeat(5000), "tts-1-hd", "nova")).not.toBe(audioSegmentKey("a".repeat(5000) + "b", "tts-1-hd", "nova"));
});
it("rejects oversize sources instead of silently cutting the book", () => expect(() => sourceParagraphs([{ page: 1, locator: null, text: "а".repeat(60001) }])).toThrow());
