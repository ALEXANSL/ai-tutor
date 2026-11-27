import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { NarratedDeck } from "@/lib/narrated-deck";
import type { JobHandler } from "@/server/jobs/runner";

const f = vi.hoisted(() => ({
  author: vi.fn(), material: vi.fn(), design: vi.fn(),
  register: vi.fn(), get: vi.fn(), update: vi.fn(), vision: vi.fn(), voice: vi.fn(), exists: vi.fn(), save: vi.fn(),
  source: vi.fn(), render: vi.fn(), visual: vi.fn(), image: vi.fn(), notes: vi.fn(), download: vi.fn(), upload: vi.fn(),
}));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: f.register }));
vi.mock("./store", () => ({ getDeck: f.get, updateDeck: f.update, pdfPath: () => "family/slides.pdf", pptxPath: () => "family/lesson.pptx", WORK_TYPE: "presentation.prepare" }));
vi.mock("@/server/homework/model", () => ({ callHomeworkModel: f.author }));
vi.mock("./lesson-content", () => ({ lessonSlideSource: f.material }));
vi.mock("./design", () => ({ buildLessonPptx: f.design }));
vi.mock("./visuals", () => ({ DECK_IMAGES_PER_STEP: 3, prepareSlideVisual: f.visual, loadDeckImage: f.image }));
vi.mock("./notes", () => ({ speakerNotes: f.notes }));
vi.mock("./convert", () => ({ renderDeckPdf: f.render }));
vi.mock("@/server/drive/google", async original => ({ ...await original<typeof import("@/server/drive/google")>(), downloadFile: f.source }));
vi.mock("@/server/drive/oauth", () => ({ getUserAccessToken: async () => "test" }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { getBucket: async () => ({ data: { public: false } }), from: () => ({ download: f.download, upload: f.upload }) } }) }));
vi.mock("@/server/ai/router", () => ({ callVisionStructured: f.vision }));
vi.mock("@/server/lessons/narration", () => ({ requestNarration: f.voice }));
vi.mock("@/server/audiobooks/storage", () => ({ audioExists: f.exists, saveAudioBytes: f.save }));
import { registerDeckJobs } from "./workflow";

let deck: NarratedDeck, handler: JobHandler;
const job = { family_id: "family", id: "job", payload: { deckId: "b12f1a44-d392-4365-afed-95ea8d41b8ab" }, type: "presentation.prepare", attempts: 0, max_attempts: 2 };
const run = () => handler.run(job, { deadline: Date.now() + 120000 });
beforeEach(async () => {
  vi.resetAllMocks();
  registerDeckJobs();
  handler = f.register.mock.calls[0]![1];
  deck = { driveId: "original", subjectId: "subject", state: "processing", title: "test", revision: 0, slides: [], error: "", published: false };
  f.get.mockImplementation(() => deck);
  f.update.mockImplementation((_family, _id, prev, patch) => { deck = { ...prev, ...patch, revision: prev.revision + 1 }; return deck; });
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  f.notes.mockReturnValue(["Нотатки до першого слайда", ""]);
  f.render.mockResolvedValue(bytes); f.upload.mockResolvedValue({ error: null }); f.download.mockResolvedValue({ data: new Blob([bytes]) });
  f.vision.mockResolvedValue({ result: { narration: "Текст лектора" } }); f.voice.mockResolvedValue({ audioBase64: "audio" });
});

describe("narrated teacher decks", () => {
  it("renders the original once and prepares an unpublished lesson with a recording for each slide", async () => {
    await run();
    expect(f.vision).not.toHaveBeenCalled();
    await run();
    const request = f.vision.mock.calls[0]![1];
    expect(JSON.parse(request.prompt).notes).toBe("Нотатки до першого слайда");
    expect((await PDFDocument.load(Buffer.from(request.documents[0].data, "base64"))).getPageCount()).toBe(1);
    await run(); await run(); await run();
    expect(deck.state).toBe("ready"); expect(deck.published).toBe(false);
    expect(deck.slides.every(slide => slide.ready)).toBe(true);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(f.vision).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenCalledTimes(2);
  });
  it("resumes a failed recording from its saved script and reuses a previously stored audio file", async () => {
    await run(); await run();
    f.voice.mockResolvedValueOnce(null);
    await expect(run()).rejects.toThrow("озвучити");
    expect(deck.slides[0]?.ready).toBe(false);
    f.exists.mockResolvedValueOnce(true);
    await run();
    expect(f.vision).toHaveBeenCalledTimes(1);
    expect(f.voice).toHaveBeenCalledTimes(1);
    expect(deck.slides[0]?.ready).toBe(true);
  });
  it("schedules a new server attempt after repeated speech failures and continues with the saved script", async () => {
    const { ProviderError } = await import("@/server/ai/types");
    await run(); await run();
    for (const seconds of [30, 60, 120]) {
      f.voice.mockRejectedValueOnce(new ProviderError("timeout", "openai", 504, true));
      await expect(run()).resolves.toEqual({ requeue: true, delaySeconds: seconds });
      expect(deck.state).toBe("processing");
      expect(deck.slides[0]?.narration).toBe("Текст лектора");
    }
    await run();
    expect(deck.slides[0]?.ready).toBe(true); expect(deck.retry).toBeNull();
    expect(f.vision).toHaveBeenCalledTimes(1);
  });
  it("stops before narration when a converted slide is missing", async () => {
    f.notes.mockReturnValue(["only one"]);
    await expect(run()).rejects.toThrow("кількість слайдів");
    expect(f.upload).not.toHaveBeenCalled(); expect(f.vision).not.toHaveBeenCalled();
  });
});

it("creates a lesson deck in durable steps with a real picture per slide, then voices the authored notes", async () => {
  deck.generated = { href: "/literature-v3/lesson", wishes: "Порівняй традиції" };
  f.material.mockResolvedValue("Зміст вибраного уроку");
  const slide = { heading: "Традиції", takeaway: "Приклад", caption: "Предмет", photoQuery: "", imagePrompt: " Greek olive terraces above the sea ", narration: "Придивись до форми." };
  f.author.mockResolvedValueOnce({ result: { slides: [slide, { ...slide, imagePrompt: "" }] } });
  f.visual.mockResolvedValueOnce({ kind: "ai", path: "deck-images/family/a.jpg", credit: "ШІ" }).mockResolvedValueOnce({ kind: "none" });
  f.image.mockResolvedValue(Buffer.from("jpeg"));
  f.design.mockResolvedValue(Buffer.from("presentation"));
  await run();
  expect(f.author.mock.calls[0]![0].prompt).toContain("Зміст вибраного уроку");
  expect(f.author.mock.calls[0]![0].system).toContain("imagePrompt");
  expect(deck.generated.plan?.slides[0]?.imagePrompt).toBe("Greek olive terraces above the sea");
  await run();
  expect(f.visual).toHaveBeenCalledTimes(2);
  expect(deck.generated.plan?.slides.map(s => s.visual?.kind)).toEqual(["ai", "none"]);
  await run();
  expect(f.image).toHaveBeenCalledWith("deck-images/family/a.jpg");
  expect(f.design.mock.calls[0]![2]).toEqual([Buffer.from("jpeg"), undefined]);
  expect(deck.generated).toMatchObject({ pptxReady: true, pptxBucket: "lesson-presentations" });
  await run(); await run(); await run();
  expect(deck).toMatchObject({ state: "ready", published: false });
  expect(f.source).not.toHaveBeenCalled();
  expect(f.vision).not.toHaveBeenCalled();
  expect(f.author).toHaveBeenCalledTimes(1);
  expect(f.design).toHaveBeenCalledTimes(1);
  expect(f.voice).toHaveBeenCalledTimes(2);
});

it("writes picture prompts once for a plan saved with abstract shapes before ADR-050", async () => {
  const old = { heading: "Висновок", takeaway: "Історію творять умови й люди", caption: "Схема", photoQuery: "", narration: "Підсумуймо.", drawing: [{ shape: "triangle" as const, x: 1, y: 1, width: 5, height: 5, color: "clay" as const }] };
  deck.generated = { href: "/l", wishes: "", plan: { slides: [old] } };
  f.author.mockResolvedValueOnce({ result: { prompts: ["Ancient Greek polis by the sea at sunset"] } });
  f.visual.mockResolvedValueOnce({ kind: "ai", path: "p.jpg" });
  await run();
  expect(f.author.mock.calls[0]![0].prompt).toContain("Історію творять умови й люди");
  expect(deck.generated.plan?.slides[0]?.imagePrompt).toBe("Ancient Greek polis by the sea at sunset");
  await run();
  expect(f.visual.mock.calls[0]![3]).toMatchObject({ imagePrompt: "Ancient Greek polis by the sea at sunset" });
  expect(deck.generated.plan?.slides[0]?.visual).toEqual({ kind: "ai", path: "p.jpg" });
});
