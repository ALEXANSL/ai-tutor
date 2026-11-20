import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { NarratedDeck } from "@/lib/narrated-deck";
import type { JobHandler } from "@/server/jobs/runner";

const f = vi.hoisted(() => ({
  register: vi.fn(), get: vi.fn(), update: vi.fn(), vision: vi.fn(), voice: vi.fn(), exists: vi.fn(), save: vi.fn(),
  source: vi.fn(), render: vi.fn(), notes: vi.fn(), download: vi.fn(), upload: vi.fn(),
}));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: f.register }));
vi.mock("./store", () => ({ getDeck: f.get, updateDeck: f.update, pdfPath: () => "family/slides.pdf", WORK_TYPE: "presentation.prepare" }));
vi.mock("./notes", () => ({ speakerNotes: f.notes }));
vi.mock("./convert", () => ({ renderDeckPdf: f.render }));
vi.mock("@/server/drive/google", () => ({ downloadFile: f.source }));
vi.mock("@/server/drive/oauth", () => ({ getUserAccessToken: async () => "test" }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: () => ({ download: f.download, upload: f.upload }) } }) }));
vi.mock("@/server/ai/router", () => ({ callVisionStructured: f.vision }));
vi.mock("@/server/lessons/narration", () => ({ synthesizeNarration: f.voice }));
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
  it("stops before narration when a converted slide is missing", async () => {
    f.notes.mockReturnValue(["only one"]);
    await expect(run()).rejects.toThrow("кількість слайдів");
    expect(f.upload).not.toHaveBeenCalled(); expect(f.vision).not.toHaveBeenCalled();
  });
});
