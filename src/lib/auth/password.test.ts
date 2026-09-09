// @vitest-environment node

import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("teacher password hashing", () => {
  it("hashes and verifies a ten-character password", async () => {
    const hash = await hashPassword("openpbl1234");

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword("openpbl1234", hash)).resolves.toBe(true);
    await expect(verifyPassword("incorrect1", hash)).resolves.toBe(false);
  });

  it("rejects a password shorter than ten characters", async () => {
    await expect(hashPassword("openpbl12")).rejects.toThrow(
      "between 10 and 256 characters",
    );
  });
  it("accepts the maximum length and rejects both invalid boundaries", async () => {
    const value = "p".repeat(256);
    const hash = await hashPassword(value);
    await expect(verifyPassword(value, hash)).resolves.toBe(true);
    await expect(hashPassword("p".repeat(9))).rejects.toThrow("between 10 and 256");
    await expect(hashPassword("p".repeat(257))).rejects.toThrow("between 10 and 256");
  });

  it("continues verifying existing passwords shorter than the new-password minimum", async () => {
    const salt = Buffer.alloc(16, 1);
    const derived = scryptSync("oldpass8", salt, 64, { N: 16384, r: 8, p: 1 });
    const stored = `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
    await expect(verifyPassword("oldpass8", stored)).resolves.toBe(true);
  });
});
