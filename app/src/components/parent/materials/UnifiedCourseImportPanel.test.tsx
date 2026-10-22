// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), commit: vi.fn(), upload: vi.fn(), fetch: vi.fn() }));
vi.mock("@/app/actions/unified-course-import", () => ({ inspectUnifiedCourseAction: mocks.inspect, importUnifiedCourseAction: mocks.commit }));
vi.mock("@/lib/supabase-browser", () => ({ getBrowserSupabaseStorageClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: mocks.upload }) } }) }));
vi.mock("@/lib/busy-signal", () => ({ withBusySignal: (work: () => unknown) => work() }));
const { UnifiedCourseImportPanel } = await import("./UnifiedCourseImportPanel");
const preview = { title: "Географія — навчальний курс", formatLabel: "Спільний пакет курсу", lessons: 12, tasks: 30, images: 0, pdfs: 0, warnings: [] as string[], existing: false, fingerprint: "verified-hash", canImport: true };
const summary = { title: preview.title, lessons: 12, tasks: 30, assetsUploaded: 0, warnings: [] as string[] };
let root: Root | null;
let container: HTMLDivElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.inspect.mockResolvedValue({ status: "ready", preview });
  mocks.commit.mockResolvedValue({ status: "ok", summary });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ token: "signed", path: `family/upload-${mocks.fetch.mock.calls.length}.zip` }) }));
  vi.stubGlobal("fetch", mocks.fetch);
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<UnifiedCourseImportPanel subjects={[{ id: "geo", code: "geography", name: "Географія" }, { id: "math", code: "math", name: "Математика" }]} />));
});
afterEach(() => { act(() => root?.unmount()); root = null; container.remove(); vi.unstubAllGlobals(); });

async function selectSubject(id = "geo") {
  const select = container.querySelector("select")!;
  await act(async () => { select.value = id; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function chooseFile(name = "geography.zip") {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["zip"], name, { type: "application/zip" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(text: string) { return [...container.querySelectorAll("button")].find(item => item.textContent === text); }
async function click(text: string) {
  const target = button(text);
  if (!target) throw new Error(`Missing button ${text}`);
  await act(async () => target.click());
}
async function ready() { await selectSubject(); await chooseFile(); await click("Перевірити архів"); }

describe("one archive course upload", () => {
  it("uploads one ZIP and requires a verified preview before any import", async () => {
    await ready();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload.mock.calls[0]![2]).toBeInstanceOf(File);
    expect(mocks.inspect).toHaveBeenCalledWith({ subjectId: "geo", storagePath: "family/upload-1.zip" });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(container.textContent).toContain(preview.title);
    expect(button("Додати курс")).toBeDefined();
    await click("Додати курс");
    expect(mocks.commit).toHaveBeenCalledWith({ subjectId: "geo", storagePath: "family/upload-1.zip", fingerprint: "verified-hash" });
    expect(container.textContent).toContain("Курс додано");
  });

  it("allows a text-only package with no images or lesson PDFs", async () => {
    await ready();
    expect(container.textContent).toContain("Ілюстрацій");
    expect(container.textContent).toContain("PDF уроків");
    expect(button("Додати курс")?.disabled).toBe(false);
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it("blocks duplicate inspection and import clicks synchronously", async () => {
    const inspection = deferred<unknown>(); mocks.inspect.mockReturnValue(inspection.promise);
    await selectSubject(); await chooseFile();
    const inspectButton = button("Перевірити архів")!;
    await act(async () => { inspectButton.click(); inspectButton.click(); });
    expect(mocks.upload).toHaveBeenCalledTimes(1); expect(mocks.inspect).toHaveBeenCalledTimes(1);
    await act(async () => { inspection.resolve({ status: "ready", preview }); });
    const importing = deferred<unknown>(); mocks.commit.mockReturnValue(importing.promise);
    const importButton = button("Додати курс")!;
    await act(async () => { importButton.click(); importButton.click(); });
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    await act(async () => { importing.resolve({ status: "ok", summary }); });
  });

  it("retries a failed import with the already uploaded ZIP rather than uploading individual files again", async () => {
    mocks.commit.mockResolvedValueOnce({ status: "error", message: "Спробуйте повторити імпорт", retryable: true });
    await ready(); await click("Додати курс");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Спробуйте повторити");
    await click("Повторити імпорт");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.inspect).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(2);
    expect(mocks.commit.mock.calls[1]).toEqual(mocks.commit.mock.calls[0]);
  });

  it("invalidates preview and staged selectors when the subject changes", async () => {
    await ready(); await selectSubject("math");
    expect(button("Додати курс")).toBeUndefined();
    expect(container.querySelector('[aria-label="Вміст архіву"]')).toBeNull();
    await click("Перевірити архів");
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.inspect).toHaveBeenLastCalledWith({ subjectId: "math", storagePath: "family/upload-2.zip" });
  });

  it("invalidates preview when another ZIP is selected", async () => {
    await ready(); await chooseFile("other.zip");
    expect(button("Додати курс")).toBeUndefined();
    await click("Перевірити архів");
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.upload.mock.calls[1]![2].name).toBe("other.zip");
  });

  it("shows every preflight warning and does not offer import when the server blocks publication", async () => {
    mocks.inspect.mockResolvedValue({ status: "ready", preview: { ...preview, canImport: false, warnings: ["Потрібен підручник", "Невідома версія"] } });
    await ready();
    expect(container.textContent).toContain("Потрібен підручник"); expect(container.textContent).toContain("Невідома версія");
    expect(button("Додати курс")).toBeUndefined(); expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("does not present warning-bearing imports as an entirely clean result", async () => {
    mocks.commit.mockResolvedValue({ status: "ok", summary: { ...summary, warnings: ["Один PDF недоступний"] } });
    await ready(); await click("Додати курс");
    expect(container.textContent).toContain("Курс додано із зауваженнями"); expect(container.textContent).toContain("Один PDF недоступний");
  });

  it("does not run server actions for a non-ZIP file", async () => {
    await selectSubject(); await chooseFile("course.pdf"); await click("Перевірити архів");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Потрібен один ZIP");
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("does not restore a preview after unmount while inspection is pending", async () => {
    const inspection = deferred<unknown>(); mocks.inspect.mockReturnValue(inspection.promise);
    await selectSubject(); await chooseFile(); await click("Перевірити архів");
    act(() => { root!.unmount(); root = null; });
    await act(async () => { inspection.resolve({ status: "ready", preview }); });
    expect(container.textContent).toBe(""); expect(mocks.commit).not.toHaveBeenCalled();
  });
});
