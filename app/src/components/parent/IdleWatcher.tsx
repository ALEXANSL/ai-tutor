"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { exitParentModeAction, touchParentModeAction } from "@/app/actions/parent-mode";

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

/**
 * Parent mode on the tablet ends after N idle minutes (US-1.5 KP-3). The
 * server-side cookie has the same deadline and is extended only on activity,
 * so closing the tab or freezing JS cannot keep the cabinet open.
 */
export function IdleWatcher({ idleMinutes }: { idleMinutes: number }) {
  const lastActivity = useRef(0);
  const lastTouch = useRef(0);
  const exiting = useRef(false);
  const router = useRouter();

  useEffect(() => {
    const start = Date.now();
    lastActivity.current = start;
    lastTouch.current = start;
    const idleMs = idleMinutes * 60_000;
    const onActivity = () => {
      lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const timer = window.setInterval(async () => {
      if (exiting.current) return;
      const now = Date.now();
      if (now - lastActivity.current >= idleMs) {
        exiting.current = true;
        await exitParentModeAction();
        return;
      }
      // Extend the server deadline at most once a minute, and only after activity.
      if (lastActivity.current > lastTouch.current && now - lastTouch.current >= 60_000) {
        lastTouch.current = now;
        const ok = await touchParentModeAction();
        if (!ok) {
          exiting.current = true;
          router.replace("/today");
        }
      }
    }, 5_000);
    return () => {
      window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [idleMinutes, router]);

  return null;
}
