"use client";

import { useEffect } from "react";
import { endParentModeSilentlyAction } from "@/app/actions/parent-mode";

/** Being on a child screen means the parent has left the cabinet: end parent mode. */
export function ParentModeAutoExit({ active }: { active: boolean }) {
  useEffect(() => {
    if (active) void endParentModeSilentlyAction();
  }, [active]);
  return null;
}
