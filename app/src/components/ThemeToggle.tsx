"use client";

import { useSyncExternalStore } from "react";
import { uk } from "@/i18n/uk";

type Theme = "light" | "dark";

function currentTheme(): Theme {
  const manual = document.documentElement.dataset.theme;
  if (manual === "light" || manual === "dark") return manual;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const listeners = new Set<() => void>();

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("theme", t);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", cb);
  return () => {
    listeners.delete(cb);
    media.removeEventListener("change", cb);
  };
}

/** Manual light/dark switch; without a manual choice the device theme is used (docs/04 §1). */
export function ThemeToggle({ variant = "child" }: { variant?: "child" | "parent" }) {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  const active = variant === "child" ? "bg-primary text-white" : "bg-p-primary text-white";
  const base = variant === "child" ? "bg-surface border-line text-text" : "bg-p-surface border-p-line text-p-text";
  return (
    <div role="group" aria-label={uk.theme.label} className={`flex gap-1 rounded-full border p-1 font-parent ${base}`}>
      {(["light", "dark"] as const).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => applyTheme(t)}
          className={`min-h-9 rounded-full px-3 text-xs font-bold ${theme === t ? active : ""}`}
        >
          {uk.theme[t]}
        </button>
      ))}
    </div>
  );
}
