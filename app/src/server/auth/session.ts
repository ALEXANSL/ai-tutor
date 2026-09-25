import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getAllowlist, getPinPepper, getPublicSupabaseConfig } from "../env";
import { createUserClient } from "../supabase/clients";
import { resolveRole, type AppRole } from "./allowlist";
import {
  DEVICE_COOKIE,
  PARENT_MODE_COOKIE,
  deriveParentModeKey,
  verifyParentModeToken,
} from "./parent-mode-token";

export type ParentModeState = "active" | "expired" | "none";

export interface UserContext {
  kind: "user";
  authUserId: string;
  appUserId: string;
  familyId: string;
  role: AppRole;
  /** Only for a child session on the tablet: parent unlocked the cabinet with the PIN. */
  parentMode: ParentModeState;
}

export type SessionContext =
  | { kind: "not_configured" }
  | { kind: "anonymous" }
  | { kind: "forbidden"; authUserId: string }
  | { kind: "unregistered"; authUserId: string }
  | UserContext;

/**
 * Resolves who is calling. The allowlist is re-checked on every request, so
 * removing an e-mail from the env variables revokes access immediately.
 */
export const getSessionContext = cache(async (): Promise<SessionContext> => {
  // Always per-request: never prerender a page that depends on who is signed in.
  await connection();
  if (!getPublicSupabaseConfig()) return { kind: "not_configured" };
  const supabase = await createUserClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "anonymous" };

  const decision = resolveRole(user.email, getAllowlist());
  if (!decision.ok) return { kind: "forbidden", authUserId: user.id };

  const { data: row } = await supabase
    .from("app_users")
    .select("id, family_id, role")
    .eq("auth_user_id", user.id)
    .maybeSingle<{ id: string; family_id: string; role: AppRole }>();
  if (!row || row.role !== decision.role) return { kind: "unregistered", authUserId: user.id };

  const base = {
    kind: "user" as const,
    authUserId: user.id,
    appUserId: row.id,
    familyId: row.family_id,
    role: row.role,
  };
  return { ...base, parentMode: row.role === "child" ? await readParentMode(base) : "none" };
});

async function readParentMode(user: { appUserId: string; familyId: string }): Promise<ParentModeState> {
  const store = await cookies();
  const token = store.get(PARENT_MODE_COOKIE)?.value;
  if (!token) return "none";
  const pepper = getPinPepper();
  if (!pepper) return "expired";
  const claims = verifyParentModeToken(token, deriveParentModeKey(pepper), {
    uid: user.appUserId,
    fam: user.familyId,
    deviceId: store.get(DEVICE_COOKIE)?.value,
    now: new Date(),
  });
  return claims ? "active" : "expired";
}
