import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed httpOnly `parent_mode` cookie (docs/02 8.3, ADR-002 p.4).
 * The child's Supabase session stays as is; this token proves the PIN was
 * entered on THIS device for THIS family, and expires after the idle window.
 * The signing key is derived from PIN_PEPPER with a separate label, so no
 * additional secret is needed.
 */
export const PARENT_MODE_COOKIE = "parent_mode";
export const DEVICE_COOKIE = "device_id";

export interface ParentModeClaims {
  v: 1;
  /** app_users.id of the child session the token was issued for */
  uid: string;
  /** family id */
  fam: string;
  /** sha256 of the device id cookie */
  dev: string;
  /** issued at, epoch ms */
  iat: number;
  /** expires at, epoch ms (idle deadline) */
  exp: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function deriveParentModeKey(pepper: string): Buffer {
  if (!pepper || pepper.length < 16) throw new Error("PIN_PEPPER is missing or too short");
  return createHmac("sha256", pepper).update("ai-tutor/parent-mode-cookie/v1").digest();
}

export function hashDeviceId(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("base64url");
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function issueParentModeToken(
  params: { uid: string; fam: string; deviceId: string; idleMinutes: number; now: Date },
  key: Buffer,
): { token: string; claims: ParentModeClaims } {
  const iat = params.now.getTime();
  const claims: ParentModeClaims = {
    v: 1,
    uid: params.uid,
    fam: params.fam,
    dev: hashDeviceId(params.deviceId),
    iat,
    exp: iat + params.idleMinutes * 60_000,
  };
  const payload = b64url(JSON.stringify(claims));
  return { token: `${payload}.${sign(payload, key)}`, claims };
}

export function verifyParentModeToken(
  token: string | undefined | null,
  key: Buffer,
  expected: { uid: string; fam: string; deviceId: string | undefined | null; now: Date },
): ParentModeClaims | null {
  if (!token || !expected.deviceId) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  const expectedSig = Buffer.from(sign(payload, key));
  const actualSig = Buffer.from(signature);
  if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) return null;

  let claims: ParentModeClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ParentModeClaims;
  } catch {
    return null;
  }
  if (claims.v !== 1) return null;
  if (claims.uid !== expected.uid || claims.fam !== expected.fam) return null;
  if (claims.dev !== hashDeviceId(expected.deviceId)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= expected.now.getTime()) return null;
  return claims;
}
