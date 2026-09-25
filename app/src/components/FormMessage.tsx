import type { FormState } from "@/app/actions/state";

export function FormMessage({ state, className = "" }: { state: FormState; className?: string }) {
  if (state.status === "idle" || !state.message) return null;
  const tone = state.status === "ok" ? "text-secondary" : "text-danger";
  return (
    <p role={state.status === "error" ? "alert" : "status"} className={`text-sm font-bold ${tone} ${className}`}>
      {state.message}
    </p>
  );
}
