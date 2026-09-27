// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructors = vi.hoisted(() => vi.fn());
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor(options: unknown) { constructors(options); }
  },
}));

const originalPrisma = globalThis.__openPblPrisma;
const originalProvider = globalThis.__openPblProviderPrisma;

beforeEach(() => {
  vi.resetModules();
  constructors.mockClear();
  globalThis.__openPblPrisma = undefined;
  globalThis.__openPblProviderPrisma = undefined;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_URL", "postgresql://offline.invalid/main");
  vi.stubEnv("PROVIDER_CONFIG_DATABASE_URL", "");
});
afterEach(() => {
  globalThis.__openPblPrisma = originalPrisma;
  globalThis.__openPblProviderPrisma = originalProvider;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Prisma instance across production module evaluations", () => {
  it("constructs one client even when independent module caches evaluate the source again", async () => {
    const first = await import("./client");
    vi.resetModules();
    const second = await import("./client");
    expect(second.prisma).toBe(first.prisma);
    expect(globalThis.__openPblPrisma).toBe(first.prisma);
    expect(second.providerPrisma).toBe(first.prisma);
    expect(constructors).toHaveBeenCalledTimes(1);
    expect(constructors).toHaveBeenCalledWith({ log: ["error"] });
  });

  it("retains a separate shared provider client only when its configured URL differs", async () => {
    vi.stubEnv("PROVIDER_CONFIG_DATABASE_URL", "postgresql://offline.invalid/providers");
    const first = await import("./client");
    vi.resetModules();
    const second = await import("./client");
    expect(first.providerPrisma).not.toBe(first.prisma);
    expect(second.prisma).toBe(first.prisma);
    expect(second.providerPrisma).toBe(first.providerPrisma);
    expect(constructors).toHaveBeenCalledTimes(2);
    expect(constructors).toHaveBeenLastCalledWith({ datasourceUrl: "postgresql://offline.invalid/providers", log: ["error"] });
  });

  it("shares the primary client when provider URL equals the primary URL", async () => {
    vi.stubEnv("PROVIDER_CONFIG_DATABASE_URL", "postgresql://offline.invalid/main");
    const { prisma, providerPrisma } = await import("./client");
    expect(providerPrisma).toBe(prisma);
    expect(constructors).toHaveBeenCalledTimes(1);
  });
});
