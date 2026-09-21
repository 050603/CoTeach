import { describe, expect, it } from "vitest";
import {
  isLocalOllamaEmbeddingEndpoint,
  TEXTBOOK_EMBEDDING_DIMENSIONS,
  vectorSqlLiteral,
} from "./embedding";

describe("textbook embedding validation", () => {
  it("serializes only a complete finite vector", () => {
    const vector = Array.from({ length: TEXTBOOK_EMBEDDING_DIMENSIONS }, (_, index) => index / 1000);
    expect(vectorSqlLiteral(vector)).toMatch(/^\[0,0\.001,/);
    expect(() => vectorSqlLiteral(vector.slice(1))).toThrow(/1024/);
    expect(() => vectorSqlLiteral([...vector.slice(0, -1), Number.NaN])).toThrow(/1024/);
  });

  it("only recognizes the dedicated Ollama loopback endpoint", () => {
    expect(isLocalOllamaEmbeddingEndpoint("ollama-embedding", "http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLocalOllamaEmbeddingEndpoint("qwen-embedding", "http://127.0.0.1:11434/v1")).toBe(false);
    expect(isLocalOllamaEmbeddingEndpoint("ollama-embedding", "http://127.0.0.1:11435/v1")).toBe(false);
    expect(isLocalOllamaEmbeddingEndpoint("ollama-embedding", "http://example.com/v1")).toBe(false);
  });
});
