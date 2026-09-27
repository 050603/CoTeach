// Prisma client singleton.
// Share across hot reloads and production entry bundles. Next can compile this
// source into distinct module IDs for instrumentation and request handlers.

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

globalThis.__openPblPrisma = prisma;

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
