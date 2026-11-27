import "server-only";

/** D-140 (Alex, 2026-11-27): only two people use the app, so parent mode lasts until
 * "Вийти з режиму тата" is pressed. No idle timer and no exit when a child screen
 * opens on the same device. Set PARENT_MODE_AUTO_EXIT=1 to bring both back. */
export const parentModeAutoExit = () => process.env.PARENT_MODE_AUTO_EXIT === "1";
/** Lifetime of a parent-mode session without auto-exit (the browser cookie limit). */
export const PARENT_MODE_MANUAL_MINUTES = 400 * 24 * 60;
export const parentModeMinutes = (idleMinutes: number) => parentModeAutoExit() ? idleMinutes : PARENT_MODE_MANUAL_MINUTES;
