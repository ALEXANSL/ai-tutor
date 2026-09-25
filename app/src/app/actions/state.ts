/** Shape returned by form Server Actions to `useActionState`. */
export interface FormState {
  status: "idle" | "ok" | "error";
  message?: string;
}

export const idleState: FormState = { status: "idle" };
