import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { isValidPinFormat } from "@/lib/pin-format";

/**
 * PIN hashing (NFR-PRIV-9, ADR-002): argon2id with a random per-hash salt and
 * the server-side pepper (PIN_PEPPER) as argon2 "secret". The PIN itself is
 * never logged, stored or sent anywhere else.
 */
const ARGON2ID = 2; // Algorithm.Argon2id (const enum in the typings)
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
export const MIN_PEPPER_LENGTH = 16;

function secretFrom(pepper: string): Uint8Array {
  if (typeof pepper !== "string" || pepper.length < MIN_PEPPER_LENGTH) {
    throw new Error("PIN_PEPPER is missing or too short");
  }
  return new TextEncoder().encode(pepper);
}

export async function hashPin(pin: string, pepper: string): Promise<string> {
  if (!isValidPinFormat(pin)) throw new Error("invalid PIN format");
  return hash(pin, { ...OPTIONS, secret: secretFrom(pepper) });
}

export async function verifyPin(pinHash: string, pin: string, pepper: string): Promise<boolean> {
  if (!isValidPinFormat(pin) || !pinHash) return false;
  try {
    return await verify(pinHash, pin, { secret: secretFrom(pepper) });
  } catch {
    return false;
  }
}
