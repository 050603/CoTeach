import type { LanguageModel } from 'ai';

type ConcreteLanguageModel = Exclude<LanguageModel, string>;
type ModelCallOptions = Parameters<ConcreteLanguageModel['doGenerate']>[0];
type LegacyFileData = Uint8Array | string | URL;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unsupportedFileData(model: ConcreteLanguageModel, kind: unknown): Error {
  return Object.assign(new Error(
    `Legacy language model ${model.provider}/${model.modelId} cannot accept file data type ${typeof kind === 'string' ? kind : 'unknown'}`,
  ), { code: 'LEGACY_LANGUAGE_MODEL_FILE_DATA_UNSUPPORTED', isRetryable: false });
}

function legacyFileData(value: unknown, model: ConcreteLanguageModel): LegacyFileData {
  if (typeof value === 'string' || value instanceof Uint8Array || value instanceof URL) return value;
  if (!record(value)) throw unsupportedFileData(model, undefined);
  if (value.type === 'data' && (typeof value.data === 'string' || value.data instanceof Uint8Array)) return value.data;
  if (value.type === 'url' && value.url instanceof URL) return value.url;
  // A v3 file string means base64, not plain text or a provider reference.
  // Reject unsupported semantics before provider I/O instead of serializing
  // a tagged object as "[object Object]" or silently changing its meaning.
  throw unsupportedFileData(model, value.type);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

function legacyToolFile(part: Record<string, unknown>, model: ConcreteLanguageModel): Record<string, unknown> {
  const data = legacyFileData(part.data, model);
  const { data: _taggedData, ...metadata } = part;
  return data instanceof URL
    ? { ...metadata, type: 'file-url', url: data.toString() }
    : { ...metadata, type: 'file-data', data: typeof data === 'string' ? data : base64(data) };
}

function legacyPart(part: unknown, model: ConcreteLanguageModel): unknown {
  if (!record(part)) return part;
  if (part.type === 'file') {
    const data = legacyFileData(part.data, model);
    return data === part.data ? part : { ...part, data };
  }
  if (part.type !== 'tool-result' || !record(part.output)
    || part.output.type !== 'content' || !Array.isArray(part.output.value)) return part;
  const original = part.output.value;
  const value = original.map((item) => record(item) && item.type === 'file' ? legacyToolFile(item, model) : item);
  return value.every((item, index) => item === original[index])
    ? part : { ...part, output: { ...part.output, value } };
}

function legacyCallOptions(options: ModelCallOptions, model: ConcreteLanguageModel): ModelCallOptions {
  const prompt = options.prompt.map((message) => {
    const original = message.content;
    if (!Array.isArray(original)) return message;
    const content = original.map((part) => legacyPart(part, model));
    return content.every((part, index) => part === original[index]) ? message : { ...message, content };
  });
  return prompt.every((message, index) => message === options.prompt[index])
    ? options : { ...options, prompt } as ModelCallOptions;
}

/** AI SDK 7 uses tagged v4 file data even with v2/v3 providers. Unwrap it at
 * the actual legacy provider boundary, before any middleware advertises v4.
 * All bytes, URLs, metadata, call settings and provider results are preserved. */
export function adaptLegacyLanguageModelFileData(model: ConcreteLanguageModel): ConcreteLanguageModel {
  if (model.specificationVersion === 'v4') return model;
  return new Proxy(model, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if ((property === 'doGenerate' || property === 'doStream') && typeof value === 'function') {
        return (options: ModelCallOptions, ...rest: unknown[]) =>
          Reflect.apply(value, target, [legacyCallOptions(options, target), ...rest]);
      }
      return value;
    },
  });
}
