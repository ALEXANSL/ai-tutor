import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ subjects: vi.fn(), upload: vi.fn(), drive: vi.fn() }));
vi.mock("@/server/books/queries", () => ({ listSubjects: f.subjects }));
vi.mock("@/server/drive/service", () => ({ isUploadsFolderConfigured: f.upload, isDriveConfigured: f.drive }));
vi.mock("@/components/parent/materials/UnifiedCourseImportPanel", () => ({ UnifiedCourseImportPanel: () => <button>Універсальний промпт ZIP</button> }));
vi.mock("@/components/parent/materials/VideoLessonUploadPanel", () => ({ VideoLessonUploadPanel: () => <p>Відеоформа</p> }));
vi.mock("@/components/parent/materials/MaterialsImportPanel", () => ({ MaterialsImportPanel: ({ materialsOnly }: { materialsOnly: boolean }) => <p>{materialsOnly ? "Лише джерела" : "Старий імпорт"}</p> }));
vi.mock("@/components/parent/books/AddBookPanel", () => ({ AddBookPanel: ({ uploadEnabled }: { uploadEnabled: boolean }) => <p>{uploadEnabled ? "Додати книгу" : "Завантаження недоступне"}</p> }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
import { StudioImports } from "./StudioImports";
it("provides one ZIP/prompt home with separate source/video panels and no old multi-file importers", async () => {
  f.subjects.mockResolvedValue([]); f.upload.mockResolvedValue(true); f.drive.mockResolvedValue(true);
  const html = renderToStaticMarkup(await StudioImports({ familyId: "own-family", tab: "course" }));
  expect(f.subjects).toHaveBeenCalledWith("own-family"); expect(html).toContain("Універсальний промпт ZIP"); expect(html).toContain("Додати книгу"); expect(html).toContain("Лише джерела"); expect(html).not.toContain("Старий імпорт"); expect(html).not.toContain("Старі способи завантаження");
});
