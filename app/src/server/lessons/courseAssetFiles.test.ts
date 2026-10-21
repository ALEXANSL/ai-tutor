import { describe, expect, it } from "vitest";
import { collectReferencedAssetFiles } from "./courseAssetFiles";
import { parseLiteratureV3Assets } from "./literatureV3Import";

const pdf = new Uint8Array([37,80,68,70]);
const image = new Uint8Array([82,73,70,70]);
describe("catalog-driven package assets", () => {
  it("keeps Geography lesson_pdfs alongside illustrations and ignores unrelated files", () => {
    const files = collectReferencedAssetFiles({ "lesson_pdfs/L001.pdf": pdf, "assets/figures/F001.webp": image, "preview.html": image }, ["lesson_pdfs/L001.pdf", "assets/figures/F001.webp"]);
    expect([...files.keys()]).toEqual(["lesson_pdfs/L001.pdf", "assets/figures/F001.webp"]);
    expect(files.get("lesson_pdfs/L001.pdf")).toBe(pdf);
  });
  it("accepts a full package in one enclosing directory and Windows path separators", () => {
    const files = collectReferencedAssetFiles({ "Geography/lesson_pdfs/L001.pdf": pdf, "Geography\\assets\\figures\\F001.webp": image }, ["lesson_pdfs/L001.pdf", "assets/figures/F001.webp"]);
    expect(files.size).toBe(2);
  });
  it("preserves old assets/lessons packages and optional leading dot paths", () => {
    expect(collectReferencedAssetFiles({ "./assets/lessons/L001.pdf": pdf }, ["assets/lessons/L001.pdf"]).get("assets/lessons/L001.pdf")).toBe(pdf);
  });
  it("does not invent bytes for a catalog-only package", () => {
    expect(collectReferencedAssetFiles({}, ["assets/figures/F001.webp", "lesson_pdfs/L001.pdf"]).size).toBe(0);
  });
  it("matches the new lessons folder to catalog lesson_pdfs references", () => {
    expect(collectReferencedAssetFiles({ "Geography/lessons/L001.pdf": pdf }, ["lesson_pdfs/L001.pdf"], ["lesson_pdfs/L001.pdf"]).get("lesson_pdfs/L001.pdf")).toBe(pdf);
  });
  it("accepts a ZIP of PDF folder contents only in the dedicated PDF input", () => {
    const entries = { "L001.pdf": pdf };
    const paths = ["lesson_pdfs/L001.pdf"];
    expect(collectReferencedAssetFiles(entries, paths, paths).size).toBe(0);
    expect(collectReferencedAssetFiles(entries, paths, paths, true).get(paths[0]!)).toBe(pdf);
  });
  it("does not guess between duplicate PDF filenames across catalog folders", () => {
    const paths = ["book-one/L001.pdf", "book-two/L001.pdf"];
    expect(() => collectReferencedAssetFiles({ "lessons/L001.pdf": pdf }, paths, paths)).toThrow(/неоднозначна/);
  });
  it("does not treat image filenames as lesson PDF folder aliases", () => {
    expect(collectReferencedAssetFiles({ "lessons/F001.webp": image }, ["assets/figures/F001.webp"]).size).toBe(0);
  });
  it("rejects ambiguous wrapper folders rather than attaching a different book", () => {
    expect(() => collectReferencedAssetFiles({ "one/lesson_pdfs/L001.pdf": pdf, "two/lesson_pdfs/L001.pdf": image }, ["lesson_pdfs/L001.pdf"])).toThrow(/кілька/);
  });
  it.each(["../secret.pdf", "/absolute.pdf", "https://example.com/a.pdf", "C:\\a.pdf", "assets/../a.pdf"])("rejects unsafe catalog path %s", path => {
    expect(() => collectReferencedAssetFiles({}, [path])).toThrow(/шлях/);
  });
  it("supports Geography workbook illustrations through the existing image category", () => {
    const parsed = parseLiteratureV3Assets({ items: [{ id: "geography-A01", kind: "workbook_illustration", path: "assets/extra.png", mime_type: "image/png", page_id: null, caption: "Схема", alt: "Схема" }] });
    expect(parsed.errors).toEqual([]);
    expect(parsed.assets[0]?.kind).toBe("textbook_illustration");
  });
});
