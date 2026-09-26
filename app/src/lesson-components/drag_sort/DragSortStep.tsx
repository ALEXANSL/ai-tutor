"use client";

import { useRef, useState } from "react";
import { uk } from "@/i18n/uk";
import { evaluateDragSort, type DragSortAnswer, type DragSortProps } from "./index";

/**
 * "Перетягни й співстав" (US-6.8 КП-2а, КП-4; docs/04 4.2). Two independent
 * ways to place a card, both always available:
 *  - pointer drag (mouse and touch alike via Pointer Events);
 *  - tap-tap: tap a card to select it (highlighted), then tap a slot.
 * Cards/slots are >= 48px targets with >= 12px gaps (NFR-A11Y-1). "Перевірити"
 * shows per-slot correct/retry feedback without locking (a wrong slot can be
 * redone), never a plain red cross (docs/04 tone rules).
 */
export function DragSortStep({
  props,
  onSubmit,
}: {
  props: DragSortProps;
  onSubmit: (answer: DragSortAnswer, correct: boolean) => void;
}) {
  const t = uk.child.lesson.dragSort;
  const [placement, setPlacement] = useState<DragSortAnswer>({});
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ correct: boolean; detail: Record<string, boolean> } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const dragRef = useRef<{ itemId: string } | null>(null);
  const slotRefs = useRef<Map<string, HTMLElement>>(new Map());

  const placedItemIds = new Set(Object.keys(placement));
  const unplaced = props.items.filter((i) => !placedItemIds.has(i.id));

  function place(itemId: string, slotId: string) {
    setPlacement((prev) => ({ ...prev, [itemId]: slotId }));
    setChecked(null);
    setSelectedCard(null);
  }

  function unplace(itemId: string) {
    setPlacement((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setChecked(null);
  }

  // Tap-tap alternative (NFR-A11Y-1): tap a card, then tap the target slot.
  function onCardTap(itemId: string) {
    if (selectedCard === itemId) {
      setSelectedCard(null);
      return;
    }
    setSelectedCard(itemId);
  }
  function onSlotTap(slotId: string) {
    if (selectedCard) {
      place(selectedCard, slotId);
      return;
    }
    // Tapping a filled slot without a selection frees the card back up.
    const occupant = Object.entries(placement).find(([, s]) => s === slotId)?.[0];
    if (occupant) unplace(occupant);
  }

  // Pointer-based free drag (works the same on touch and mouse, docs/04 4.2).
  function onCardPointerDown(itemId: string) {
    dragRef.current = { itemId };
  }
  function onSlotPointerUp(slotId: string) {
    if (!dragRef.current) return;
    place(dragRef.current.itemId, slotId);
    dragRef.current = null;
  }

  function handleCheck() {
    if (unplaced.length > 0) {
      setToast(t.fillAllFirst);
      return;
    }
    setToast(null);
    const result = evaluateDragSort(props, placement);
    setChecked(result);
    onSubmit(placement, result.correct);
  }

  return (
    <div className="rounded-[22px] border border-line bg-surface p-4.5" data-testid="drag-sort-step">
      <p className="mb-3.5 text-base font-bold">{props.instructionUk}</p>

      <div className="mb-4 flex flex-wrap gap-3" role="listbox" aria-label={t.cardsLabel}>
        {props.items.map((item) => {
          const placedAt = placement[item.id];
          const isSelected = selectedCard === item.id;
          const isCorrect = checked?.detail[item.id] === true;
          const isWrong = checked && checked.detail[item.id] === false && placedAt;
          return (
            <button
              key={item.id}
              type="button"
              draggable={!placedAt}
              onPointerDown={() => onCardPointerDown(item.id)}
              onClick={() => (placedAt ? unplace(item.id) : onCardTap(item.id))}
              aria-pressed={isSelected}
              aria-label={item.labelUk}
              className={`min-h-12 min-w-12 rounded-2xl border-2 px-3.5 py-2.5 text-sm font-bold transition ${
                placedAt ? "opacity-40" : isSelected ? "border-[var(--accent-voice)] bg-surface-alt" : "border-line bg-bg"
              } ${isCorrect ? "border-secondary" : ""} ${isWrong ? "border-danger" : ""}`}
            >
              {item.labelUk}
              {isCorrect ? " ✓" : ""}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="list" aria-label={t.slotsLabel}>
        {props.slots.map((slot) => {
          const occupant = Object.entries(placement).find(([, s]) => s === slot.id)?.[0];
          const occupantCard = props.items.find((i) => i.id === occupant);
          const isCorrect = occupant ? checked?.detail[occupant] === true : false;
          const isWrong = occupant ? checked && checked.detail[occupant] === false : false;
          return (
            <div
              key={slot.id}
              ref={(el) => {
                if (el) slotRefs.current.set(slot.id, el);
              }}
              onPointerUp={() => onSlotPointerUp(slot.id)}
              onClick={() => onSlotTap(slot.id)}
              role="button"
              tabIndex={0}
              aria-label={`${slot.labelUk}${occupantCard ? `: ${occupantCard.labelUk}` : ""}`}
              className={`flex min-h-14 items-center justify-center rounded-2xl border-2 border-dashed px-2 py-3 text-center text-sm font-semibold ${
                occupant ? "border-solid bg-surface-alt" : "border-line bg-bg"
              } ${isCorrect ? "border-secondary bg-secondary/10" : ""} ${isWrong ? "border-danger" : ""}`}
            >
              <span>
                {slot.labelUk}
                {occupantCard ? <><br />{occupantCard.labelUk}</> : null}
                {isCorrect ? " ✓" : isWrong ? ` · ${t.tryAgain}` : ""}
              </span>
            </div>
          );
        })}
      </div>

      {toast && <p className="mt-3 text-sm font-semibold text-warn">{toast}</p>}

      <button
        type="button"
        onClick={handleCheck}
        className="mt-4 inline-flex min-h-12 items-center justify-center rounded-2xl bg-primary px-5 text-base font-bold text-white active:scale-[0.98]"
      >
        {t.check}
      </button>
    </div>
  );
}
