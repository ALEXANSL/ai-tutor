import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildFolderPlan,
  buildSectionsForImport,
  buildUnitsForImport,
  classifyStatus,
  type FolderParseResult,
  NEW_SUBJECT_NAME_HINTS,
  parseIndexJson,
  parseManualBatchZip,
  parsePagesJsonl,
  SUBJECT_SLUG_MAP,
} from "./manual-batch";

// ADR-031 §3.2/§3.3 fixtures — mirrors the real export's shape.
const indexEntry = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "1",
  section: "Розділ 1",
  title: "§1. Вступ",
  printed_start: 6,
  pdf_start: 8,
  pdf_end: 10,
  status: "text_in_pdf",
  ...over,
});

describe("classifyStatus (§3.3)", () => {
  it("recognises the three known statuses", () => {
    expect(classifyStatus("text_in_pdf")).toBe("text_in_pdf");
    expect(classifyStatus("image_only")).toBe("image_only");
    expect(classifyStatus("QR_external_check_pdf")).toBe("QR_external_check_pdf");
  });
  it("treats anything else as 'unknown' — never silently text_in_pdf", () => {
    expect(classifyStatus("something_new_from_a_future_tool_version")).toBe("unknown");
    expect(classifyStatus("")).toBe("unknown");
  });
});

describe("parseIndexJson / parsePagesJsonl (§3.2)", () => {
  it("parses a well-formed index.json array", () => {
    const entries = parseIndexJson(JSON.stringify([indexEntry(), indexEntry({ id: 2, title: "§2", pdf_start: 11, pdf_end: 14, status: "image_only" })]));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ id: "1", section: "Розділ 1", title: "§1. Вступ", printedStart: 6, pdfStart: 8, pdfEnd: 10, status: "text_in_pdf" });
    expect(entries[1]!.status).toBe("image_only");
  });

  it("defaults a missing/null section to '' (fallback section, §3.5)", () => {
    const entries = parseIndexJson(JSON.stringify([indexEntry({ section: null })]));
    expect(entries[0]!.section).toBe("");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseIndexJson("not json")).toThrow();
  });

  it("throws when the shape does not match the contract", () => {
    expect(() => parseIndexJson(JSON.stringify([{ id: 1 }]))).toThrow();
  });

  it("parses pages.jsonl, one object per line", () => {
    const raw = `${JSON.stringify({ pdf_page: 8, printed_page: 6, text: "Текст 1" })}\n${JSON.stringify({ pdf_page: 9, printed_page: 7, text: "Текст 2" })}\n`;
    const pages = parsePagesJsonl(raw);
    expect(pages).toEqual([
      { pdfPage: 8, printedPage: 6, text: "Текст 1" },
      { pdfPage: 9, printedPage: 7, text: "Текст 2" },
    ]);
  });

  it("drops a malformed line instead of failing the whole file", () => {
    const raw = `${JSON.stringify({ pdf_page: 8, text: "ok" })}\nnot json\n${JSON.stringify({ wrong: "shape" })}\n`;
    expect(parsePagesJsonl(raw)).toEqual([{ pdfPage: 8, printedPage: null, text: "ok" }]);
  });

  it("skips blank lines", () => {
    const raw = `${JSON.stringify({ pdf_page: 1, text: "a" })}\n\n\n`;
    expect(parsePagesJsonl(raw)).toHaveLength(1);
  });
});

describe("buildFolderPlan (§3.3/§3.7)", () => {
  const folder = (entries: ReturnType<typeof indexEntry>[]): FolderParseResult => ({
    slug: "istoriia",
    entries: entries.map((e) => ({
      id: String(e.id),
      section: (e.section as string) ?? "",
      title: e.title as string,
      printedStart: (e.printed_start as number) ?? null,
      pdfStart: e.pdf_start as number,
      pdfEnd: e.pdf_end as number,
      status: classifyStatus(e.status as string),
    })),
    pages: [],
    parseErrors: [],
  });

  it("counts importable/image_only/needs-review separately", () => {
    const plan = buildFolderPlan(
      folder([
        indexEntry({ id: 1, status: "text_in_pdf" }),
        indexEntry({ id: 2, status: "text_in_pdf", section: "Розділ 2" }),
        indexEntry({ id: 3, status: "image_only" }),
        indexEntry({ id: 4, status: "QR_external_check_pdf" }),
        indexEntry({ id: 5, status: "something_unknown" }),
      ]),
    );
    expect(plan.importableCount).toBe(2);
    expect(plan.sectionsCount).toBe(2);
    expect(plan.imageOnlyCount).toBe(1);
    expect(plan.qrCount).toBe(1);
    expect(plan.unknownStatusCount).toBe(1);
    expect(plan.wholeFolderRejected).toBe(false);
    expect(plan.needsReviewTitles).toHaveLength(2);
  });

  it("§3.3: a folder that is ENTIRELY image_only is rejected as a whole", () => {
    const plan = buildFolderPlan(folder([indexEntry({ status: "image_only" }), indexEntry({ id: 2, status: "image_only" })]));
    expect(plan.wholeFolderRejected).toBe(true);
    expect(plan.importableCount).toBe(0);
  });

  it("a folder that is only PARTLY image_only is not whole-rejected", () => {
    const plan = buildFolderPlan(folder([indexEntry({ status: "image_only" }), indexEntry({ id: 2, status: "text_in_pdf" })]));
    expect(plan.wholeFolderRejected).toBe(false);
    expect(plan.importableCount).toBe(1);
  });

  it("§3.7: known slugs map to their subject_code, unknown ones don't", () => {
    expect(buildFolderPlan({ ...folder([indexEntry()]), slug: "ukr_mova" }).suggestedSubjectCode).toBe("ukrainian_language");
    expect(buildFolderPlan({ ...folder([indexEntry()]), slug: "pryroda" }).suggestedSubjectCode).toBeNull();
    expect(buildFolderPlan({ ...folder([indexEntry()]), slug: "pryroda" }).suggestedNewSubjectName).toBe(NEW_SUBJECT_NAME_HINTS.pryroda);
    expect(buildFolderPlan({ ...folder([indexEntry()]), slug: "some_new_slug" }).suggestedSubjectCode).toBeNull();
    expect(buildFolderPlan({ ...folder([indexEntry()]), slug: "some_new_slug" }).suggestedNewSubjectName).toBeNull();
  });

  it("a folder that fails to parse at all is never whole-rejected as a scan (different reason)", () => {
    const bad: FolderParseResult = { slug: "x", entries: [], pages: [], parseErrors: ["missing_index_json"] };
    const plan = buildFolderPlan(bad);
    expect(plan.parseOk).toBe(false);
    expect(plan.wholeFolderRejected).toBe(false);
  });
});

describe("buildSectionsForImport / buildUnitsForImport (§3.4/§3.5)", () => {
  const folder: FolderParseResult = {
    slug: "istoriia",
    entries: [
      { id: "1", section: "Розділ 1", title: "§1. Вступ", printedStart: 6, pdfStart: 8, pdfEnd: 10, status: "text_in_pdf" },
      { id: "2", section: "Розділ 1", title: "§2. Продовження", printedStart: 9, pdfStart: 11, pdfEnd: 12, status: "text_in_pdf" },
      { id: "3", section: "", title: "§3. Сканована", printedStart: 13, pdfStart: 13, pdfEnd: 14, status: "image_only" },
      { id: "4", section: "Розділ 2", title: "§4. QR", printedStart: 15, pdfStart: 15, pdfEnd: 15, status: "QR_external_check_pdf" },
    ],
    pages: [
      { pdfPage: 8, printedPage: 6, text: "стор 8" },
      { pdfPage: 9, printedPage: 7, text: "стор 9" },
      { pdfPage: 10, printedPage: 8, text: "стор 10" },
      { pdfPage: 11, printedPage: 9, text: "стор 11" },
      { pdfPage: 12, printedPage: 10, text: "стор 12" },
      { pdfPage: 13, printedPage: 11, text: "скан, не імпортується" },
      { pdfPage: 15, printedPage: 13, text: "QR, не імпортується" },
    ],
    parseErrors: [],
  };

  it("builds one section per unique `section`, only from text_in_pdf entries", () => {
    const sections = buildSectionsForImport(folder);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ title: "Розділ 1", page_from: 8, page_to: 12 });
    expect(sections[0]!.topics.map((t) => t.title)).toEqual(["§1. Вступ", "§2. Продовження"]);
  });

  it("only pages covered by an IMPORTED entry's pdf range become units (§3.4)", () => {
    const units = buildUnitsForImport(folder);
    expect(units.map((u) => u.page)).toEqual([8, 9, 10, 11, 12]);
    // locator carries the PRINTED page, never the pdf page (§3.5).
    expect(units[0]).toEqual({ page: 8, locator: "6", text: "стор 8" });
  });

  it("a folder with no importable entries yields no units at all", () => {
    const allRejected: FolderParseResult = { ...folder, entries: folder.entries.filter((e) => e.status !== "text_in_pdf") };
    expect(buildUnitsForImport(allRejected)).toEqual([]);
  });

  it("an empty/missing section falls back to 'Без розділу'", () => {
    const f: FolderParseResult = {
      slug: "x",
      entries: [{ id: "1", section: "", title: "§1", printedStart: null, pdfStart: 1, pdfEnd: 2, status: "text_in_pdf" }],
      pages: [],
      parseErrors: [],
    };
    expect(buildSectionsForImport(f)[0]!.title).toBe("Без розділу");
  });
});

describe("parseManualBatchZip (§3.1)", () => {
  function zipOf(files: Record<string, string>): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(files)) entries[path] = strToU8(content);
    return zipSync(entries);
  }

  it("recognises form (а) — manifest.json at the root", () => {
    const bytes = zipOf({ "manifest.json": "{}" });
    expect(parseManualBatchZip(bytes)).toEqual({ form: "single_manifest" });
  });

  it("recognises form (б) — several subject-folders, no root manifest.json", () => {
    const bytes = zipOf({
      "README.md": "не парситься",
      "ukr_mova/index.json": JSON.stringify([indexEntry()]),
      "ukr_mova/pages.jsonl": JSON.stringify({ pdf_page: 8, printed_page: 6, text: "текст" }),
      "ukr_mova/index.csv": "ігнорується",
      "ukr_mova/lessons/1.md": "ігнорується",
      "istoriia/index.json": JSON.stringify([indexEntry({ status: "image_only" })]),
      "istoriia/pages.jsonl": "",
    });
    const parsed = parseManualBatchZip(bytes);
    expect(parsed.form).toBe("batch");
    if (parsed.form !== "batch") throw new Error("unreachable");
    expect(parsed.folders.map((f) => f.slug)).toEqual(["istoriia", "ukr_mova"]);
    const ukrMova = parsed.folders.find((f) => f.slug === "ukr_mova")!;
    expect(ukrMova.entries).toHaveLength(1);
    expect(ukrMova.pages).toHaveLength(1);
    expect(ukrMova.parseErrors).toEqual([]);
  });

  it("reports a missing index.json/pages.jsonl instead of throwing", () => {
    const bytes = zipOf({ "onlypages/pages.jsonl": "" });
    const parsed = parseManualBatchZip(bytes);
    if (parsed.form !== "batch") throw new Error("unreachable");
    expect(parsed.folders[0]!.parseErrors).toContain("missing_index_json");
  });

  it("an empty zip is reported, not crashed on", () => {
    expect(parseManualBatchZip(zipOf({}))).toEqual({ form: "empty" });
  });
});

describe("SUBJECT_SLUG_MAP (§3.7 real slugs, checked against the ADR's table)", () => {
  it("maps the 5 confidently-matched slugs", () => {
    expect(SUBJECT_SLUG_MAP).toMatchObject({
      ukr_mova: "ukrainian_language",
      ukr_literatura: "ukrainian_literature",
      zar_literatura: "foreign_literature",
      istoriia: "history",
      geografiia: "geography",
    });
  });
  it("intentionally has NO entry for informatyka/pryroda/zdorovia — no matching subject exists", () => {
    expect(SUBJECT_SLUG_MAP.informatyka).toBeUndefined();
    expect(SUBJECT_SLUG_MAP.pryroda).toBeUndefined();
    expect(SUBJECT_SLUG_MAP.zdorovia).toBeUndefined();
  });
});
