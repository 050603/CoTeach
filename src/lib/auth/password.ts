import { isValidNewPasswordLength, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "./password-policy";
import { scrypt, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// OWASP's minimum Argon2id profile: 19 MiB, two iterations, one lane.
// The native implementation runs outside the JavaScript event loop.
const ARGON2_OPTIONS = {
  algorithm: 2,
  version: 1,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (!isValidNewPasswordLength(password)) {
    throw new Error(`Password must contain between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (stored.startsWith("$argon2id$")) {
      return await verify(stored, password);
    }
    return await verifyLegacyScrypt(password, stored);
  } catch {
    return false;
  }
}

export function passwordNeedsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2id$");
}

async function verifyLegacyScrypt(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < 2 ||
    r < 1 ||
    p < 1
  ) {
    return false;
  }
  const salt = Buffer.from(parts[4], "hex");
  const expectedHash = Buffer.from(parts[5], "hex");
  if (salt.length !== 16 || expectedHash.length !== 64) return false;
  const actualHash = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expectedHash.length, { N, r, p }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
  return timingSafeEqual(actualHash, expectedHash);
}
