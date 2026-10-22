import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ rows: new Map<string, unknown[]>(), calls: [] as { familyId: string; table: string }[], sign: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => ({
  select: (table: string) => {
    fixture.calls.push({ familyId, table });
    const chain = {
      eq: () => chain, in: () => chain,
      maybeSingle: async () => ({ data: fixture.rows.get(table)?.[0] ?? null }),
      returns: async () => ({ data: fixture.rows.get(table) ?? [] }),
    };
    return chain;
  },
  client: { storage: { from: () => ({ createSignedUrls: fixture.sign }) } },
}) }));
const { getLiteratureV3LessonView } = await import("./literatureV3View");

beforeEach(() => {
  fixture.calls.length = 0;
  fixture.rows.clear();
  fixture.sign.mockReset().mockResolvedValue({ data: [{ path: "asset/path", signedUrl: "https://example.com/signed-image" }] });
  fixture.rows.set("literature_v3_lessons", [{ id: "lesson", subject_id: "history", topic_id: "topic", package_id: "package", title: "Історія", status: "active", flow: [{ kind: "screen", ref_id: "intro" }] }]);
  fixture.rows.set("literature_v3_packages", [{ title: "Підручник" }]);
  fixture.rows.set("literature_v3_screens", [{ id: "screen", screen_key: "intro", title: "Вірування", content_display: "Текст для пояснення", asset_ids: ["figure"] }]);
  fixture.rows.set("literature_v3_assets", [{ asset_key: "figure", storage_path: "asset/path", caption: "Рисунок", alt: "Артефакт" }]);
});

describe("text-only chapter context for voice", () => {
  it("keeps public text and step identity without querying or signing unused illustrations", async () => {
    const view = await getLiteratureV3LessonView("family", "lesson", { includeIllustrations: false });
    expect(view?.flow[0]).toMatchObject({ id: "screen", displayText: "Текст для пояснення", illustrations: [] });
    expect(fixture.calls.some(call => call.table === "literature_v3_assets")).toBe(false);
    expect(fixture.sign).not.toHaveBeenCalled();
    expect(fixture.calls.every(call => call.familyId === "family")).toBe(true);
  });
  it("preserves illustrations and signed URLs for the actual lesson viewer by default", async () => {
    const view = await getLiteratureV3LessonView("family", "lesson");
    expect(view?.flow[0]).toMatchObject({ illustrations: [{ assetKey: "figure", url: "https://example.com/signed-image" }] });
    expect(fixture.sign).toHaveBeenCalledWith(["asset/path"], expect.any(Number));
  });
});
