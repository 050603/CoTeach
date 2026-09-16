// Prisma client singleton.
// Avoids exhausting DB connections in dev (Next.js hot reload would otherwise
// create a new PrismaClient on every reload).

import { PrismaClient } from "@prisma/client";

declare global {
  var __openPblPrisma: PrismaClient | undefined;
  var __openPblProviderPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__openPblPrisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__openPblPrisma = prisma;
}

const providerDatabaseUrl = process.env.PROVIDER_CONFIG_DATABASE_URL?.trim();

/**
 * AI provider settings can be shared by multiple CoTeach deployments while
 * their users, courses and classroom data stay in separate databases.
 */
export const providerPrisma: PrismaClient =
  !providerDatabaseUrl || providerDatabaseUrl === process.env.DATABASE_URL
    ? prisma
    : (globalThis.__openPblProviderPrisma ??=
        new PrismaClient({
          datasourceUrl: providerDatabaseUrl,
          log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
        }));

/**
 * Whether the database layer is configured.
 * When false, callers should fall back to the JSON file store and log a warning.
 */
export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return Boolean(url && url.startsWith("postgres"));
}

export function isProviderDatabaseConfigured(): boolean {
  const url = providerDatabaseUrl || process.env.DATABASE_URL;
  return Boolean(url && url.startsWith("postgres"));
}
