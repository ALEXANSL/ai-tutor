"use client";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
interface HomeNavigation { run(): boolean; register(action: () => void): () => void }
const HomeNavigationContext = createContext<HomeNavigation | null>(null);

export function HomeNavigationProvider({ children }: { children: React.ReactNode }) {
  const action = useRef<(() => void) | null>(null);
  const navigation = useMemo<HomeNavigation>(() => ({
    run() { if (!action.current) return false; action.current(); return true; },
    register(handler) { action.current = handler; return () => { if (action.current === handler) action.current = null; }; },
  }), []);
  return <HomeNavigationContext.Provider value={navigation}>{children}</HomeNavigationContext.Provider>;
}
export function useHomeNavigation() { return useContext(HomeNavigationContext); }

/** Stateful legacy sessions must save/pause before home navigation. */
export function useHomeExit(action: () => void) {
  const target = useHomeNavigation();
  useEffect(() => target?.register(action), [target, action]);
}
