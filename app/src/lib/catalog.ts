/**
 * D-142: one parent catalog of every material the family has (lessons,
 * narrated presentations, videos, audio, books). Pure helpers only, so the
 * filtering rules are shared by the page and its tests.
 */
export const CATALOG_KINDS = ["lesson", "presentation", "video", "audio", "book"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export const CATALOG_STATUSES = ["child", "review", "preparing", "attention", "ready", "off"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];
export const CATALOG_PERIODS = ["week", "month", "older"] as const;
export type CatalogPeriod = (typeof CATALOG_PERIODS)[number];
export const CATALOG_SORTS = ["new", "old", "title"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const kindLabels: Record<CatalogKind, string> = { lesson: "Урок", presentation: "Презентація з озвучкою", video: "Відео", audio: "Аудіо", book: "Книга або джерело" };
export const kindPlural: Record<CatalogKind, string> = { lesson: "Уроки", presentation: "Презентації", video: "Відео", audio: "Аудіо", book: "Книги та джерела" };
export const kindIcons: Record<CatalogKind, string> = { lesson: "📘", presentation: "🖼️", video: "🎬", audio: "🎧", book: "📚" };
export const statusLabels: Record<CatalogStatus, string> = { child: "Доступно дитині", review: "Чекає перегляду", preparing: "Готується", attention: "Потрібна увага", ready: "Готово", off: "Предмет вимкнено" };
export const periodLabels: Record<CatalogPeriod, string> = { week: "Останні 7 днів", month: "Останні 30 днів", older: "Старіші за місяць" };
export const sortLabels: Record<CatalogSort, string> = { new: "Спершу нові", old: "Спершу старі", title: "За назвою" };

export interface CatalogItem {
  /** `<kind>:<id>`, also the archive key. */
  key: string;
  kind: CatalogKind;
  title: string;
  subjectId: string | null;
  subjectName: string | null;
  /** Lesson topic the material belongs to, when it is not the title itself. */
  topicTitle: string | null;
  grade: number | null;
  createdAt: string;
  status: CatalogStatus;
  href: string;
  cover: string | null;
  /** Short extra facts, e.g. «Є відео MP4». */
  notes: string[];
  archived: boolean;
}

export interface CatalogFilters {
  q: string;
  kind: CatalogKind | "";
  subject: string;
  status: CatalogStatus | "";
  grade: string;
  period: CatalogPeriod | "";
  sort: CatalogSort;
  archived: boolean;
}

const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[]): T | "" => (allowed as readonly string[]).includes(value ?? "") ? value as T : "";

export function parseCatalogFilters(params: { get(name: string): string | null }): CatalogFilters {
  return {
    q: (params.get("q") ?? "").slice(0, 120),
    kind: pick(params.get("type"), CATALOG_KINDS),
    subject: (params.get("subject") ?? "").slice(0, 64),
    status: pick(params.get("status"), CATALOG_STATUSES),
    grade: /^\d{1,2}$/.test(params.get("grade") ?? "") ? params.get("grade")! : "",
    period: pick(params.get("period"), CATALOG_PERIODS),
    sort: pick(params.get("sort"), CATALOG_SORTS) || "new",
    archived: params.get("archive") === "1",
  };
}

/** Only non-default values go to the URL, so a shared link stays short. */
export function catalogQueryString(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.kind) params.set("type", filters.kind);
  if (filters.subject) params.set("subject", filters.subject);
  if (filters.status) params.set("status", filters.status);
  if (filters.grade) params.set("grade", filters.grade);
  if (filters.period) params.set("period", filters.period);
  if (filters.sort !== "new") params.set("sort", filters.sort);
  if (filters.archived) params.set("archive", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const normalizeSearch = (text: string) => text.toLocaleLowerCase("uk").replace(/ё/g, "е").replace(/[’'`ʼ]/g, "").replace(/\s+/g, " ").trim();

/** Every word must appear somewhere in the title, topic, subject or type. */
export function matchesSearch(item: CatalogItem, query: string) {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const haystack = normalizeSearch([item.title, item.topicTitle, item.subjectName, kindLabels[item.kind], statusLabels[item.status], ...item.notes].filter(Boolean).join(" "));
  return words.every(word => haystack.includes(word));
}

const DAY = 86_400_000;
export function inPeriod(createdAt: string, period: CatalogPeriod | "", now = Date.now()) {
  if (!period) return true;
  const age = now - Date.parse(createdAt);
  if (Number.isNaN(age)) return period === "older";
  return period === "week" ? age <= 7 * DAY : period === "month" ? age <= 30 * DAY : age > 30 * DAY;
}

/** Applies everything except the archive switch to one item. */
export function matchesFilters(item: CatalogItem, filters: CatalogFilters, now = Date.now()) {
  return (!filters.kind || item.kind === filters.kind)
    && (!filters.subject || item.subjectId === filters.subject)
    && (!filters.status || item.status === filters.status)
    && (!filters.grade || String(item.grade ?? "") === filters.grade)
    && inPeriod(item.createdAt, filters.period, now)
    && matchesSearch(item, filters.q);
}

export function filterCatalog(items: readonly CatalogItem[], filters: CatalogFilters, now = Date.now()): CatalogItem[] {
  const visible = items.filter(item => item.archived === filters.archived && matchesFilters(item, filters, now));
  const byTitle = (a: CatalogItem, b: CatalogItem) => a.title.localeCompare(b.title, "uk", { numeric: true });
  return visible.sort(filters.sort === "title" ? byTitle
    : filters.sort === "old" ? (a, b) => a.createdAt.localeCompare(b.createdAt) || byTitle(a, b)
    : (a, b) => b.createdAt.localeCompare(a.createdAt) || byTitle(a, b));
}

/** Counts per kind for the current archive view, ignoring the kind filter itself. */
export function kindCounts(items: readonly CatalogItem[], filters: CatalogFilters, now = Date.now()) {
  const counts = Object.fromEntries(CATALOG_KINDS.map(kind => [kind, 0])) as Record<CatalogKind, number>;
  for (const item of items) if (item.archived === filters.archived && matchesFilters(item, { ...filters, kind: "" }, now)) counts[item.kind] += 1;
  return counts;
}

export const ARCHIVE_KEY = /^(lesson|presentation|video|audio|book):[0-9a-f-]{36}$/i;
