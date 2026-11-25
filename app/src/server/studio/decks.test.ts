import { beforeEach, expect, it, vi } from "vitest";
const queueLessonDeck = vi.fn();
vi.mock("@/server/decks/lesson-deck", () => ({
  queueLessonDeck: (...args: unknown[]) => queueLessonDeck(...args),
  studioDeckKey: (family: string, project: string, index: number) => ["studio-deck", family, project, index],
  studioDeckId: () => "id",
}));
vi.mock("@/server/decks/store", () => ({ getDeck: vi.fn() }));
import { queueStudioDecks } from "./decks";
import { studioProjectFixture } from "./__fixtures__/project";

const publication = { subjectId: "subject", packageId: "package", lessons: [{ id: "l1", topicId: "t1", title: "Перший" }, { id: "l2", topicId: "t2", title: "Другий" }] };
beforeEach(() => { queueLessonDeck.mockReset(); queueLessonDeck.mockImplementation(async (_f: string, r: { key: unknown[] }) => String(r.key[3])); });

it("queues one presentation per published lesson with a stable per-project key", async () => {
  const project = studioProjectFixture({ state: "published" });
  project.request = { ...project.request, narratedDeck: true };
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual(["0", "1"]);
  expect(queueLessonDeck).toHaveBeenCalledWith("family", expect.objectContaining({ key: ["studio-deck", "family", "project", 1], subjectId: "subject", topicId: "t2", href: "/literature-v3/l2", title: "Другий" }));
});

it("does nothing for projects that did not ask for presentations, including older ones", async () => {
  const project = studioProjectFixture({ state: "published" });
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual([]);
  project.request = { ...project.request, narratedDeck: false };
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual([]);
  expect(queueLessonDeck).not.toHaveBeenCalled();
});

it("places a revision's presentation on the base lesson and survives a queue failure", async () => {
  const project = studioProjectFixture({ state: "published" });
  project.request = { ...project.request, mode: "revision", topicId: "base", narratedDeck: true };
  queueLessonDeck.mockRejectedValueOnce(new Error("db"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual(["1"]);
  expect(queueLessonDeck).toHaveBeenLastCalledWith("family", expect.objectContaining({ topicId: "base" }));
});
