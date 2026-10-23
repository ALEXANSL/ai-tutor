import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * S47 (+ S47b, several videos per topic): a small in-memory fake for
 * `video_lessons` plus a stubbed Storage client (`createSignedUrl`/
 * `remove`) — real enough to exercise the existence check, the per-topic
 * video list, on-demand signing by video id, insert-always-adds, and
 * delete-removes-both behaviors without a real Supabase client.
 */
interface VideoRow { [key: string]: unknown; id: string; owner_family_id: string; subject_id: string; topic_id: string; storage_path: string; mime_type: string; size_bytes: number; created_at: string }
interface TopicRow { [key: string]: unknown; id: string; title: string }

let rows: VideoRow[] = [];
const topics: TopicRow[] = [{ id: "t1", title: "Параграф 16" }, { id: "t2", title: "Параграф 17" }];
let subjects: Record<string, unknown>[] = [];
let groups: Record<string, unknown>[] = [];
let nextId = 1;
let nextCreatedAtMinute = 0;
const removedPaths: string[][] = [];
const signCalls: string[] = [];

function applyFilters(list: Record<string, unknown>[], filters: [string, unknown][]) {
  return list.filter((row) => filters.every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v)));
}
function queryBuilder(list: Record<string, unknown>[], filters: [string, unknown][] = [], sortKey: string | null = null, ascending = true) {
  const builder = {
    eq: (k: string, v: unknown) => queryBuilder(list, [...filters, [k, v]], sortKey, ascending),
    in: (k: string, v: unknown[]) => queryBuilder(list, [...filters, [k, v]], sortKey, ascending),
    order: (key: string, options?: { ascending?: boolean }) => queryBuilder(list, filters, key, options?.ascending ?? true),
    returns: async () => {
      const matched = applyFilters(list, filters);
      if (sortKey) matched.sort((a, b) => (ascending ? 1 : -1) * String(a[sortKey]).localeCompare(String(b[sortKey])));
      return { data: matched, error: null };
    },
    maybeSingle: async () => ({ data: applyFilters(list, filters)[0] ?? null, error: null }),
  };
  return builder;
}
function tableOf(table: string): Record<string, unknown>[] {
  if (table === "video_lessons") return rows;
  if (table === "topics") return topics;
  if (table === "subjects") return subjects;
  if (table === "course_groups") return groups;
  return [];
}
const scope = {
  select: (table: string) => queryBuilder(tableOf(table), [["owner_family_id", "fam1"]]),
  insert: (_table: string, row: Record<string, unknown>) => {
    const saved: VideoRow = { id: `vl${nextId++}`, owner_family_id: "fam1", created_at: `2026-10-27T00:${String(nextCreatedAtMinute++).padStart(2, "0")}:00Z`, ...row } as VideoRow;
    rows.push(saved);
    return { select: () => ({ single: async () => ({ data: { id: saved.id }, error: null }) }) };
  },
  delete: (_table: string) => ({
    eq: (k: string, v: unknown) => {
      rows = rows.filter((r) => r[k] !== v);
      return Promise.resolve({ error: null });
    },
  }),
  client: {
    from: (table: string) => ({
      select: (columns: string) => {
        // `listVideoLessonsForSubject`'s raw `.select(...).eq(...).eq(...).order(...)` chain.
        void columns;
        return queryBuilder(
          tableOf(table).map((r) => ({ ...r, topics: topics.find((t) => t.id === (r as VideoRow).topic_id) })),
          [],
        );
      },
    }),
    storage: {
      from: () => ({
        createSignedUrl: async (path: string) => {
          signCalls.push(path);
          return { data: { signedUrl: `https://example.com/signed/${path}` }, error: null };
        },
        remove: async (paths: string[]) => {
          removedPaths.push(paths);
          return { data: null, error: null };
        },
      }),
    },
  },
};
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

const { listVideoLessonsForSubject, listTopicIdsWithVideoLesson, listTopicVideos, getVideoLessonUrlById, saveVideoLesson, deleteVideoLesson } = await import("./videoLessons");

beforeEach(() => {
  rows = [];
  subjects = [{ id: "subj1", owner_family_id: "fam1", active: true, kind: "school_subject", group_id: null, is_stub: false }];
  groups = [];
  nextId = 1;
  nextCreatedAtMinute = 0;
  removedPaths.length = 0;
  signCalls.length = 0;
});

describe("video lessons (S47)", () => {
  it("lists a subject's video lessons with their topic title, newest first", async () => {
    rows.push({ id: "vl1", owner_family_id: "fam1", subject_id: "subj1", topic_id: "t1", storage_path: "fam1/a.mp4", mime_type: "video/mp4", size_bytes: 100, created_at: "2026-10-27T00:00:00Z" });
    rows.push({ id: "vl2", owner_family_id: "fam1", subject_id: "subj1", topic_id: "t2", storage_path: "fam1/b.mp4", mime_type: "video/mp4", size_bytes: 200, created_at: "2026-10-28T00:00:00Z" });

    const list = await listVideoLessonsForSubject("fam1", "subj1");

    expect(list).toEqual([
      { id: "vl2", topicId: "t2", topicTitle: "Параграф 17", sizeBytes: 200, createdAt: "2026-10-28T00:00:00Z" },
      { id: "vl1", topicId: "t1", topicTitle: "Параграф 16", sizeBytes: 100, createdAt: "2026-10-27T00:00:00Z" },
    ]);
  });

  it("reports only the topic ids that actually have a video", async () => {
    rows.push({ id: "vl1", owner_family_id: "fam1", subject_id: "subj1", topic_id: "t1", storage_path: "fam1/a.mp4", mime_type: "video/mp4", size_bytes: 100, created_at: "2026-10-27T00:00:00Z" });

    const ids = await listTopicIdsWithVideoLesson("fam1", ["t1", "t2"]);

    expect(ids).toEqual(new Set(["t1"]));
  });

  it("returns an empty set without querying when there are no topic ids", async () => {
    expect(await listTopicIdsWithVideoLesson("fam1", [])).toEqual(new Set());
  });

  it("lists a topic's videos in upload order, labelled Відео 1/2/...", async () => {
    await saveVideoLesson("fam1", "t1", "subj1", "fam1/a.mp4", "video/mp4", 100);
    await saveVideoLesson("fam1", "t1", "subj1", "fam1/b.mp4", "video/mp4", 200);

    const list = await listTopicVideos("fam1", "t1");

    expect(list).toEqual([
      { id: "vl1", label: "Відео 1" },
      { id: "vl2", label: "Відео 2" },
    ]);
  });

  it("signs the playback URL of one specific video on demand, not ahead of time", async () => {
    rows.push({ id: "vl1", owner_family_id: "fam1", subject_id: "subj1", topic_id: "t1", storage_path: "fam1/a.mp4", mime_type: "video/mp4", size_bytes: 100, created_at: "2026-10-27T00:00:00Z" });

    const url = await getVideoLessonUrlById("fam1", "vl1");

    expect(url).toBe("https://example.com/signed/fam1/a.mp4");
    expect(signCalls).toEqual(["fam1/a.mp4"]);
  });

  it("returns null for a video id that doesn't exist", async () => {
    expect(await getVideoLessonUrlById("fam1", "missing")).toBeNull();
    expect(signCalls).toEqual([]);
  });

  it("saves a new video lesson for a topic that has none yet", async () => {
    const id = await saveVideoLesson("fam1", "t1", "subj1", "fam1/a.mp4", "video/mp4", 100);

    expect(id).toBe("vl1");
    expect(rows).toHaveLength(1);
    expect(removedPaths).toEqual([]);
  });

  it("adds a SECOND video for a topic that already has one, without touching or deleting the first (S47b)", async () => {
    const first = await saveVideoLesson("fam1", "t1", "subj1", "fam1/a.mp4", "video/mp4", 100);
    const second = await saveVideoLesson("fam1", "t1", "subj1", "fam1/b.mp4", "video/mp4", 200);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual([first, second]);
    expect(removedPaths).toEqual([]);
  });

  it("deletes both the row and the stored file, leaving the topic's other videos untouched", async () => {
    await saveVideoLesson("fam1", "t1", "subj1", "fam1/a.mp4", "video/mp4", 100);
    await saveVideoLesson("fam1", "t1", "subj1", "fam1/b.mp4", "video/mp4", 200);
    const id = rows[0]!.id;

    await deleteVideoLesson("fam1", id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.storage_path).toBe("fam1/b.mp4");
    expect(removedPaths).toEqual([["fam1/a.mp4"]]);
  });

  it("refuses to delete a video lesson that does not exist", async () => {
    await expect(deleteVideoLesson("fam1", "missing")).rejects.toThrow("video lesson not found");
  });
});

describe("video signing access", () => {
  function add() { rows.push({ id: "vl1", owner_family_id: "fam1", subject_id: "subj1", topic_id: "t1", storage_path: "fam1/a.mp4", mime_type: "video/mp4", size_bytes: 100, created_at: "2026-10-23T00:00:00Z" }); }
  it("denies videos from an inactive subject", async () => { add(); subjects[0]!.active = false; expect(await getVideoLessonUrlById("fam1", "vl1")).toBeNull(); expect(signCalls).toEqual([]); });
  it("denies courses whose group is inactive", async () => { add(); subjects[0]!.kind = "course"; subjects[0]!.group_id = "group"; groups.push({ id: "group", owner_family_id: "fam1", active: false }); expect(await getVideoLessonUrlById("fam1", "vl1")).toBeNull(); expect(signCalls).toEqual([]); });
  it("never signs another family's storage object", async () => { add(); rows[0]!.storage_path = "another/private.mp4"; expect(await getVideoLessonUrlById("fam1", "vl1")).toBeNull(); expect(signCalls).toEqual([]); });
});
