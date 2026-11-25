"use client";
import { useSyncExternalStore } from "react";
import { SCHOOL_BATCH_MAX } from "@/lib/school-day";

/** One picked diary entry. Kept in this tab's localStorage so a selection
 * survives moving between days and weeks (D-136). It is only a convenience:
 * the server re-reads every entry before queueing it. */
export type SchoolPick = { id: string; kind: "lesson" | "homework"; subject: string; label: string; date: string; linked: boolean; narratedDeck: boolean };

const KEY = "ai-tutor.studio.school-batch.v1";
const listeners = new Set<() => void>();
let cache: SchoolPick[] | null = null;
const EMPTY: SchoolPick[] = [];

function load(): SchoolPick[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter((p): p is SchoolPick => !!p && typeof p === "object" && typeof (p as SchoolPick).id === "string" && typeof (p as SchoolPick).label === "string").slice(0, SCHOOL_BATCH_MAX) : [];
  } catch { cache = []; }
  return cache;
}

function save(next: SchoolPick[]) {
  cache = next;
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: keep in memory */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) { cache = null; listener(); } };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

export function useSchoolPicks() { return useSyncExternalStore(subscribe, load, () => EMPTY); }

/** Adds picks that are not selected yet, up to the batch limit. Returns how many did not fit. */
export function addPicks(picks: Omit<SchoolPick, "narratedDeck">[]) {
  const current = load(), known = new Set(current.map(p => p.id));
  const fresh = picks.filter(p => !known.has(p.id)).map(p => ({ ...p, narratedDeck: true }));
  const room = Math.max(0, SCHOOL_BATCH_MAX - current.length);
  save([...current, ...fresh.slice(0, room)]);
  return Math.max(0, fresh.length - room);
}
export function removePicks(ids: string[]) { const drop = new Set(ids); save(load().filter(p => !drop.has(p.id))); }
export function setPickDeck(id: string, narratedDeck: boolean) { save(load().map(p => p.id === id ? { ...p, narratedDeck } : p)); }
export function clearPicks() { save([]); }
