import { beforeEach, expect, it, vi } from "vitest";
const queueLessonDeck = vi.fn();
const getDeck = vi.fn(), updateDeck = vi.fn();
vi.mock("@/server/decks/lesson-deck", () => ({
  queueLessonDeck: (...args: unknown[]) => queueLessonDeck(...args),
  studioDeckKey: (family: string, project: string, index: number, version?: string) => ["studio-deck", family, project, index, ...(version ? [version] : [])],
  studioDeckId: (_family: string, _project: string, index: number, version?: string) => `deck-${index}-${version ?? "legacy"}`,
}));
vi.mock("@/server/decks/store", () => ({ getDeck: (...args: unknown[]) => getDeck(...args), updateDeck: (...args: unknown[]) => updateDeck(...args) }));
import { queueStudioDecks, studioProjectDecks } from "./decks";
import { studioProjectFixture } from "./__fixtures__/project";

const publication = { subjectId: "subject", packageId: "package", lessons: [{ id: "l1", topicId: "t1", title: "Перший" }, { id: "l2", topicId: "t2", title: "Другий" }] };
beforeEach(() => { vi.resetAllMocks(); getDeck.mockResolvedValue(undefined); });

it("queues one presentation per published lesson with a stable per-project key", async () => {
  const project = studioProjectFixture({ state: "published" });
  project.request = { ...project.request, narratedDeck: true };
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual([]);
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
  expect(await queueStudioDecks("family", "project", project, publication)).toEqual(["l1"]);
  expect(queueLessonDeck).toHaveBeenLastCalledWith("family", expect.objectContaining({ topicId: "base" }));
  vi.mocked(console.error).mockRestore();
});

it("queues only the selected current version on retry and hides only its stale presentation", async () => {
  const revised = { ...publication, lessons: [{ ...publication.lessons[0]!, deckVersion: "new", previousDeckId: "old" }, publication.lessons[1]!] };
  const project = studioProjectFixture({ state: "published", publication: revised, deckQueueFailures: ["l1"] });
  project.request.narratedDeck = true;
  const old = { published: true };
  getDeck.mockResolvedValueOnce(old);
  expect(await queueStudioDecks("family", "project", project, revised, ["l1"])).toEqual([]);
  expect(updateDeck).toHaveBeenCalledWith("family", "old", old, { published: false });
  expect(queueLessonDeck).toHaveBeenCalledExactlyOnceWith("family", expect.objectContaining({
    key: ["studio-deck", "family", "project", 0, "new"], sourceHash: "new",
  }));
});

it("shows a queue error even if the presentation row exists, and includes missing older rows", async () => {
  const project = studioProjectFixture({ state: "published", publication, deckQueueFailures: ["l1"] });
  project.request.narratedDeck = true;
  getDeck.mockResolvedValueOnce({ state: "processing", published: false });
  expect(await studioProjectDecks("family", "project", project)).toEqual([
    { id: "deck-0-legacy", title: "Перший", lessonId: "l1", label: "Не вдалося підтвердити запуск", retry: true },
    { id: null, title: "Другий", lessonId: "l2", label: "Підготовку ще не запущено", retry: true },
  ]);
});
