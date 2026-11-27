import { describe, expect, it } from "vitest";
import { catalogQueryString, filterCatalog, kindCounts, parseCatalogFilters, type CatalogItem } from "./catalog";

const now = Date.parse("2026-11-27T12:00:00Z");
const item = (patch: Partial<CatalogItem>): CatalogItem => ({ key: "lesson:00000000-0000-4000-a000-000000000001", kind: "lesson", title: "Урок", subjectId: "s1", subjectName: "Історія", topicTitle: null, grade: 6, createdAt: "2026-11-26T10:00:00Z", status: "child", href: "/x", cover: null, notes: [], archived: false, ...patch });
const items = [
  item({ key: "lesson:1", title: "§12. Давня Греція", createdAt: "2026-11-26T10:00:00Z" }),
  item({ key: "presentation:2", kind: "presentation", title: "Острови Егейського моря", topicTitle: "§12. Давня Греція", status: "review", createdAt: "2026-11-20T10:00:00Z" }),
  item({ key: "video:3", kind: "video", title: "Дроби", subjectId: "s2", subjectName: "Математика", createdAt: "2026-09-01T10:00:00Z" }),
  item({ key: "book:4", kind: "book", title: "Підручник", subjectId: null, subjectName: null, status: "ready", archived: true }),
];
const base = parseCatalogFilters(new URLSearchParams(""));

describe("material catalog filters (D-142)", () => {
  it("hides archived items unless the archive view is on", () => {
    expect(filterCatalog(items, base, now).map(i => i.key)).toEqual(["lesson:1", "presentation:2", "video:3"]);
    expect(filterCatalog(items, { ...base, archived: true }, now).map(i => i.key)).toEqual(["book:4"]);
  });
  it("searches every word across title, topic, subject and type, ignoring case", () => {
    expect(filterCatalog(items, { ...base, q: "греція" }, now).map(i => i.key)).toEqual(["lesson:1", "presentation:2"]);
    expect(filterCatalog(items, { ...base, q: "презентація ГРЕЦІЯ" }, now).map(i => i.key)).toEqual(["presentation:2"]);
    expect(filterCatalog(items, { ...base, q: "§12" }, now)).toHaveLength(2);
  });
  it("combines type, subject, status and period filters", () => {
    expect(filterCatalog(items, { ...base, subject: "s2" }, now).map(i => i.key)).toEqual(["video:3"]);
    expect(filterCatalog(items, { ...base, status: "review" }, now).map(i => i.key)).toEqual(["presentation:2"]);
    expect(filterCatalog(items, { ...base, period: "week" }, now).map(i => i.key)).toEqual(["lesson:1"]);
    expect(filterCatalog(items, { ...base, period: "older" }, now).map(i => i.key)).toEqual(["video:3"]);
    expect(kindCounts(items, { ...base, kind: "video" }, now)).toMatchObject({ lesson: 1, presentation: 1, video: 1, book: 0 });
  });
  it("sorts by date or by title", () => {
    expect(filterCatalog(items, { ...base, sort: "old" }, now).at(0)?.key).toBe("video:3");
    expect(filterCatalog(items, { ...base, sort: "title" }, now).map(i => i.title)).toEqual(["§12. Давня Греція", "Дроби", "Острови Егейського моря"]);
  });
  it("round-trips filters through the URL and drops unknown values", () => {
    const filters = { ...base, q: "Греція", kind: "video" as const, status: "child" as const, sort: "title" as const, archived: true };
    expect(parseCatalogFilters(new URLSearchParams(catalogQueryString(filters).slice(1)))).toEqual(filters);
    expect(parseCatalogFilters(new URLSearchParams("type=evil&status=x&grade=abc&sort=zzz"))).toEqual(base);
    expect(catalogQueryString(base)).toBe("");
  });
});
