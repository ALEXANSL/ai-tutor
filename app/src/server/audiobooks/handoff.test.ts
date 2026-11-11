import { beforeEach, expect, it, vi } from "vitest";
import { audioId, bookFixture } from "./__fixtures__/part";
const f = vi.hoisted(() => ({ books: vi.fn(), cards: vi.fn() }));
vi.mock("./library", () => ({ libraryCatalog: f.books }));
vi.mock("./store", () => ({ listAudioCards: f.cards }));
import { isLibraryReadingRequest, libraryReadingHandoff, validLibraryLink } from "./handoff";
beforeEach(() => { vi.clearAllMocks(); f.books.mockResolvedValue([bookFixture]); f.cards.mockResolvedValue([{ id: audioId, materialId: bookFixture.id, title: "Острів", bookTitle: bookFixture.title, from: 23, to: 24 }]); });
it("distinguishes reading a source from explanation or exercise narration", () => {
  expect(isLibraryReadingRequest("прочитай розділ 1")).toBe(true); expect(isLibraryReadingRequest("прочитай сторінку 23")).toBe(true); expect(isLibraryReadingRequest("поясни розділ 1")).toBe(false); expect(isLibraryReadingRequest("прочитай умову задачі")).toBe(false); expect(isLibraryReadingRequest("проаналізуй, а потім прочитай роман")).toBe(false);
});
it("returns an exact prepared audio link, not generated book text", async () => {
  const reply = await libraryReadingHandoff("family", "прочитай розділ 1"); expect(reply.libraryLink.href).toBe(`/audiobooks/${audioId}`); expect(f.cards).toHaveBeenCalledWith("family", undefined, true);
});
it("missing audio returns a library link and an honest preparation message", async () => { f.cards.mockResolvedValue([]); const reply = await libraryReadingHandoff("family", "прочитай розділ 1"); expect(reply.libraryLink.href).toBe(`/library/${bookFixture.id}`); expect(reply.content).toContain("не підготовлено"); });
it("lookup failure remains an honest library handoff, no invented quotation", async () => { f.books.mockRejectedValue(new Error("offline")); expect((await libraryReadingHandoff("family", "прочитай розділ 1")).content).toContain("недоступний"); });
it("rejects foreign URLs or traversal stored as an action", () => { for (const href of ["https://evil.example", "//evil", "/library/../../parent", "/parent/settings"]) expect(validLibraryLink({ href, label: "link" })).toBe(false); expect(validLibraryLink({ href: `/audiobooks/${audioId}`, label: "Слухати" })).toBe(true); });
