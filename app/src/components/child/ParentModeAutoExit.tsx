"use client";

import { useEffect } from "react";
import { endParentModeSilentlyAction } from "@/app/actions/parent-mode";

/**
 * Being on a child screen means the parent has left the cabinet: end parent
 * mode. BUG-027: this heuristic cannot tell that apart from "a *different*
 * tab/window on this shared tablet still has a child screen open while the
 * parent is legitimately working in the cabinet elsewhere" — so
 * `endParentModeSilentlyAction` only ever softens the fallout (a friendly
 * "/today" instead of the harsh "/denied"), it does not fix the heuristic
 * itself. See `expireParentModeSilently` in `server/auth/parent-mode.ts`.
 */
export function ParentModeAutoExit({ active }: { active: boolean }) {
  useEffect(() => {
    if (active) void endParentModeSilentlyAction();
  }, [active]);
  return null;
}
