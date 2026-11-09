import { leadingParagraphNumber, orderParagraphs } from "./paragraph-order";

export interface ChapterOrderInfo { title: string; packageId?: string; page?: number | null; order?: number; }
/** Repair read order within each book without mixing books or rewriting stored IDs.
 * Explicit paragraph numbering remains authoritative. Otherwise use book pages,
 * then the package's lesson order; unknown positions retain their original slots. */
export function orderChapterLessons<T>(items: readonly T[], info: (item: T) => ChapterOrderInfo | null): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const data = info(item);
    if (!data) continue;
    const key = data.packageId ?? "unknown-package";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const sorted = new Map<string, T[]>();
  for (const [key, group] of groups) {
    const valid = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const ordered = group.map((item, index) => ({ item, index, value: info(item)!.order })).filter(entry => valid(entry.value)).sort((a, b) => a.value! - b.value! || a.index - b.index);
    let orderIndex = 0;
    const baseline = group.map(item => valid(info(item)!.order) ? ordered[orderIndex++]!.item : item);
    if (baseline.some(item => leadingParagraphNumber(info(item)!.title) !== null)) {
      sorted.set(key, orderParagraphs(baseline, item => info(item)!.title));
      continue;
    }
    const usePages = baseline.filter(item => valid(info(item)!.page) && info(item)!.page! > 0).length >= 2;
    const value = (item: T) => usePages ? info(item)!.page : info(item)!.order;
    const known = baseline.map((item, index) => ({ item, index, value: value(item) }))
      .filter(entry => valid(entry.value) && (!usePages || entry.value! > 0))
      .sort((a, b) => a.value! - b.value! || (info(a.item)!.order ?? a.index) - (info(b.item)!.order ?? b.index) || a.index - b.index);
    let index = 0;
    sorted.set(key, baseline.map(item => valid(value(item)) && (!usePages || value(item)! > 0) ? known[index++]!.item : item));
  }
  const offsets = new Map<string, number>();
  return items.map(item => {
    const data = info(item);
    if (!data) return item;
    const key = data.packageId ?? "unknown-package";
    const index = offsets.get(key) ?? 0;
    offsets.set(key, index + 1);
    return sorted.get(key)![index]!;
  });
}
