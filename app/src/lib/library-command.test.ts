import { expect, it } from "vitest";
import { matchLibraryCommand } from "./library-command";
import { bookFixture, audioId } from "@/server/audiobooks/__fixtures__/part";
import type { AudioCard } from "./audiobooks";
const card: AudioCard = { id: audioId, materialId: bookFixture.id, title: "Острів", bookTitle: bookFixture.title, state: "ready", published: true, ready: 2, total: 2, from: 23, to: 24, createdAt: "now" };
it("finds an exact chapter in the selected book", () => expect(matchLibraryCommand("прочитай розділ 1", [bookFixture], [card]).audio).toEqual([card]));
it("maps confirmed printed numbering and does not choose a nearby audio range", () => {
  expect(matchLibraryCommand("прочитай сторінки 19-20", [bookFixture], [card]).audio).toEqual([card]);
  expect(matchLibraryCommand("прочитай сторінки 19-21", [bookFixture], [card]).audio).toEqual([]);
});
it("distinguishes PDF page numbers, EPUB chapters and missing print mapping", () => {
  expect(matchLibraryCommand("прочитай PDF сторінки 23-24", [bookFixture], [card]).audio).toEqual([card]);
  expect(matchLibraryCommand("сторінки 23-24", [{ ...bookFixture, settings: { ...bookFixture.settings, printedConfirmed: false } }], [card]).message).toContain("не підтверджено");
  expect(matchLibraryCommand("сторінки 23-24", [{ ...bookFixture, format: "epub" }], [card]).message).toContain("EPUB");
});
it("asks for a specific book when several match instead of playing the wrong one", () => expect(matchLibraryCommand("прочитай розділ 1", [bookFixture, { ...bookFixture, id: audioId }], [card]).audio).toEqual([]));
it("never matches another edition merely because the title is the same", () => expect(matchLibraryCommand("розділ 1", [bookFixture], [{ ...card, materialId: audioId }]).audio).toEqual([]));
