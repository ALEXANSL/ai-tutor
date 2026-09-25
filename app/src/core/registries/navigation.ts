import { createRegistry } from "./registry";

/**
 * Navigation as configuration (US-11.8 KP-4, NFR-PLAT-6): menu items are
 * registry records, so a future module replaces/extends the "Modules (soon)"
 * placeholder without rebuilding the menu.
 */
export type NavStatus = "active" | "soon";

export interface NavItem {
  key: string;
  /** Visible label (Ukrainian UI text comes from the i18n dictionary). */
  label: string;
  icon: string;
  /** `null` for inactive placeholders: nothing opens (US-11.8 KP-2). */
  href: string | null;
  status: NavStatus;
  order: number;
  badge?: "unread_notifications";
}

export const parentNav = createRegistry<NavItem>("parentNav");
/** Extra tiles on the child's "Today" screen (e.g. the modules placeholder). */
export const childTiles = createRegistry<NavItem>("childTiles");

export function sortedNav(items: NavItem[]): NavItem[] {
  return [...items].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** A placeholder must carry no link, description or dates (US-11.8 KP-1..3). */
export function isInactivePlaceholder(item: NavItem): boolean {
  return item.status === "soon" && item.href === null;
}
