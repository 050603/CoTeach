import { createHash } from "node:crypto";

function normalized(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => normalized(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new TypeError("Cannot fingerprint a cyclic value");
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalized((value as Record<string, unknown>)[key], seen);
    }
    seen.delete(value);
    return result;
  }
  return value;
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(normalized(value, new WeakSet()));
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export function moduleInputFingerprint(input: {
  moduleId: string;
  moduleVersion: string;
  value: unknown;
  dependencyInputs?: Readonly<Record<string, unknown>>;
  modelIdentity?: Readonly<Record<string, unknown>>;
}): string {
  return fingerprint({
    moduleId: input.moduleId,
    moduleVersion: input.moduleVersion,
    value: input.value,
    dependencyInputs: input.dependencyInputs ?? {},
    modelIdentity: input.modelIdentity ?? {},
  });
}

