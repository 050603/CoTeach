import { proxyFetch } from '@openmaic/lib/server/proxy-fetch';
import { createHash } from "node:crypto";
import { resolveServerEmbeddingProvider } from "@/lib/openmaic/server/provider-config";

export const TEXTBOOK_EMBEDDING_DIMENSIONS = 1024 as const;
export const TEXTBOOK_EMBEDDING_TEXT_VERSION = "textbook-retrieval-v1";

export class TextbookEmbeddingUnavailableError extends Error {
  constructor(message = "尚未配置可用的教材向量模型。") {
    super(message);
    this.name = "TextbookEmbeddingUnavailableError";
  }
}

export type TextbookEmbeddingProfile = {
  providerId: string;
  baseUrl: string;
  model: string;
  dimensions: typeof TEXTBOOK_EMBEDDING_DIMENSIONS;
  fingerprint: string;
};

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/embeddings`;
}

/** The settings UI may bypass the generic SSRF rejection only for this exact loopback service. */
export function isLocalOllamaEmbeddingEndpoint(providerId: string, value: string): boolean {
  if (providerId !== "ollama-embedding") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port === "11434"
      && url.pathname.replace(/\/+$/, "") === "/v1"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function embeddingProfile(): TextbookEmbeddingProfile | undefined {
  const provider = resolveServerEmbeddingProvider();
  if (!provider) return undefined;
  const identity = JSON.stringify({
    providerId: provider.providerId,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    model: provider.model,
    dimensions: TEXTBOOK_EMBEDDING_DIMENSIONS,
    textVersion: TEXTBOOK_EMBEDDING_TEXT_VERSION,
  });
  return {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl,
    model: provider.model,
    dimensions: TEXTBOOK_EMBEDDING_DIMENSIONS,
    fingerprint: createHash("sha256").update(identity).digest("hex"),
  };
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === TEXTBOOK_EMBEDDING_DIMENSIONS
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export async function embedTextbookTexts(
  inputs: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ profile: TextbookEmbeddingProfile; vectors: number[][] }> {
  if (inputs.length === 0) throw new Error("至少需要一段非空文本才能生成向量。");
  if (inputs.length > 32 || inputs.some((text) => !text.trim() || text.length > 16_000)) {
    throw new Error("教材向量批次无效：每批最多 32 段，每段最多 16000 个字符。");
  }
  const provider = resolveServerEmbeddingProvider();
  const profile = embeddingProfile();
  if (!provider || !profile) throw new TextbookEmbeddingUnavailableError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("教材向量请求超时。")), 45_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await proxyFetch(endpoint(provider.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        input: inputs,
        dimensions: TEXTBOOK_EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(payload?.error?.message?.slice(0, 500) || `教材向量服务返回 ${response.status}。`);
    }
    const rows = [...(payload?.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((row) => row.embedding);
    if (vectors.length !== inputs.length || !vectors.every(validVector)) {
      throw new Error(`教材向量服务返回了错误维度；预期 ${TEXTBOOK_EMBEDDING_DIMENSIONS} 维。`);
    }
    return { profile, vectors };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function vectorSqlLiteral(vector: readonly number[]): string {
  if (!validVector(vector)) throw new Error(`教材向量必须为 ${TEXTBOOK_EMBEDDING_DIMENSIONS} 维有限数值。`);
  return `[${vector.join(",")}]`;
}
