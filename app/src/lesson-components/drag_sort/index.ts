import { z } from "zod";
import { registerLessonComponent } from "../registry";

/**
 * `drag_sort` — "Перетягни й співстав" (ADR-020, US-6.8 КП-2а). One shape
 * covers all three uses: pairs, groups and ordering (including the
 * "timeline" variant for history, ADR-020 §6) — every item is placed into
 * exactly one target slot, and the correct placement is `answer`.
 *
 * The model returns `props` and `answer`, but never markup: labels are
 * plain, short strings, checked by the generic content-safety pass in
 * `server/lessons/component-validator.ts` before this component ever runs.
 */
export const DRAG_SORT_V = 1;

const cardSchema = z.object({
  id: z.string().min(1).max(40),
  labelUk: z.string().min(1).max(80),
});

export const dragSortPropsSchema = z.object({
  variant: z.enum(["pairs", "groups", "order", "timeline"]),
  instructionUk: z.string().min(1).max(200),
  items: z.array(cardSchema).min(2).max(8),
  slots: z.array(cardSchema).min(2).max(8),
  /** The correct target slot id for every item id (ADR-020 §1 `evaluate`). */
  answer: z.record(z.string(), z.string()),
});

export type DragSortProps = z.infer<typeof dragSortPropsSchema>;
/** Student's current placement: item id -> slot id (only placed items are keys). */
export type DragSortAnswer = Record<string, string>;

export function validateDragSortSemantics(props: DragSortProps): string | null {
  const itemIds = new Set(props.items.map((i) => i.id));
  const slotIds = new Set(props.slots.map((s) => s.id));
  if (itemIds.size !== props.items.length) return "duplicate item id";
  if (slotIds.size !== props.slots.length) return "duplicate slot id";
  const answerKeys = Object.keys(props.answer);
  if (answerKeys.length !== props.items.length) return "answer must cover every item exactly once";
  for (const [itemId, slotId] of Object.entries(props.answer)) {
    if (!itemIds.has(itemId)) return `answer references unknown item "${itemId}"`;
    if (!slotIds.has(slotId)) return `answer references unknown slot "${slotId}"`;
  }
  if (props.variant === "pairs" || props.variant === "order" || props.variant === "timeline") {
    // One-to-one placement: a bijection between items and slots.
    if (props.slots.length !== props.items.length) return `variant "${props.variant}" needs one slot per item`;
    const usedSlots = new Set(Object.values(props.answer));
    if (usedSlots.size !== props.items.length) return `variant "${props.variant}" needs a distinct slot per item`;
  }
  return null;
}

export function evaluateDragSort(props: DragSortProps, answer: DragSortAnswer) {
  const detail: Record<string, boolean> = {};
  let allCorrect = true;
  for (const item of props.items) {
    const ok = answer[item.id] != null && answer[item.id] === props.answer[item.id];
    detail[item.id] = ok;
    if (!ok) allCorrect = false;
  }
  return { correct: allCorrect, detail };
}

registerLessonComponent<DragSortProps, DragSortAnswer>({
  key: "drag_sort",
  v: DRAG_SORT_V,
  propsSchema: dragSortPropsSchema,
  validateSemantics: validateDragSortSemantics,
  evaluate: evaluateDragSort,
  describe(props, verdict) {
    const n = props.items.length;
    if (!verdict) return `Крок «Перетягни й співстав»: ${props.instructionUk} (${n} карток).`;
    const okCount = Object.values(verdict.detail ?? {}).filter(Boolean).length;
    return verdict.correct
      ? `Дитина правильно розставила всі ${n} карток.`
      : `Дитина розставила ${okCount} з ${n} карток правильно, спробує ще раз.`;
  },
  promptDoc: [
    "`drag_sort` — перетягни й співстав: пари (variant=pairs, слово—переклад), групи",
    "(variant=groups, кілька карток на один слот) або порядок (variant=order; для історії —",
    "variant=timeline, картки подій у хронологічному порядку).",
    "2–8 карток (items) і 2–8 слотів (slots), кожен з коротким текстовим підписом (labelUk,",
    "без розмітки, посилань чи HTML). `answer` — правильний слот для кожної картки (itemId -> slotId).",
    "Для order/timeline: рівно один слот на картку (позиції 1..N), кожен слот використовується один раз.",
    "Приклад: variant=pairs, items=[{id:'a',labelUk:'1/2'}], slots=[{id:'s1',labelUk:'0,5'}], answer={a:'s1'}.",
  ].join(" "),
  fallback(props, fallbackText) {
    return { type: "open", content: { questionUk: fallbackText } };
  },
});
