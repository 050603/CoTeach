import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { adaptLegacyLanguageModelFileData } from './language-model-compatibility';

type ConcreteModel = Exclude<LanguageModel, string>;
type LegacyModel = Extract<ConcreteModel, { specificationVersion: 'v3' }>;
type NativeModel = Extract<ConcreteModel, { specificationVersion: 'v4' }>;
type LegacyOptions = Parameters<LegacyModel['doGenerate']>[0];
type NativeOptions = Parameters<NativeModel['doGenerate']>[0];

function legacyModel() {
  const generated: Awaited<ReturnType<LegacyModel['doGenerate']>> = {
    content: [], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 5, reasoning: 2 } },
    request: { body: { retained: true } },
    response: { id: 'original-response', modelId: 'unchanged-model', timestamp: new Date(0) },
  };
  const streamed: Awaited<ReturnType<LegacyModel['doStream']>> = {
    stream: new ReadableStream({ start(controller) { controller.close(); } }),
    request: { body: { retained: true } }, response: { headers: { 'x-original': 'stream' } },
  };
  const doGenerate = vi.fn<LegacyModel['doGenerate']>().mockResolvedValue(generated);
  const doStream = vi.fn<LegacyModel['doStream']>().mockResolvedValue(streamed);
  const model: LegacyModel = { specificationVersion: 'v3', provider: 'compat.chat', modelId: 'unchanged-model',
    supportedUrls: { 'image/*': [/^https:\/\//] }, doGenerate, doStream };
  return { model, doGenerate, doStream, generated, streamed };
}

function callOptions(data: unknown): NativeOptions {
  return {
    prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data,
      filename: 'original.png', providerOptions: { compat: { detail: 'high' } } }] }],
    maxOutputTokens: 65536, temperature: 0.2, topP: 0.9, seed: 42,
    responseFormat: { type: 'json' }, abortSignal: new AbortController().signal,
    headers: { 'x-generation': 'retained' }, providerOptions: { compat: { thinking: 'high' } },
    tools: [{ type: 'function', name: 'read', inputSchema: { type: 'object' } }],
    toolChoice: { type: 'auto' },
  } as NativeOptions;
}

describe('legacy language-model file protocol compatibility', () => {
  it.each(['doGenerate', 'doStream'] as const)('unwraps all tagged user/assistant files for %s without changing settings, metadata, input or results', async (method) => {
    const { model, doGenerate, doStream, generated, streamed } = legacyModel();
    const bytes = new Uint8Array([0, 127, 128, 255]);
    const encoded = 'AQIDBA==';
    const url = new URL('https://example.test/original.png');
    const options = callOptions({ type: 'data', data: bytes });
    const first = options.prompt[0]!;
    const firstContent = first.content as unknown as Array<Record<string, unknown>>;
    const plainText = { type: 'text', text: 'Keep source relationships intact.' };
    firstContent.unshift(plainText);
    firstContent.push({ type: 'file', mediaType: 'application/pdf', filename: 'original.pdf',
      data: { type: 'data', data: encoded }, providerOptions: { compat: { original: true } } });
    options.prompt.push({ role: 'assistant', content: [{ type: 'file', mediaType: 'image/png',
      filename: 'original-url.png', data: { type: 'url', url }, providerOptions: { compat: { original: 'url' } } }] });
    Object.freeze(options);
    Object.freeze(options.prompt);
    Object.freeze(firstContent);
    const adapted = adaptLegacyLanguageModelFileData(model) as LegacyModel;
    const result = await adapted[method](options as unknown as LegacyOptions);
    const spy = method === 'doGenerate' ? doGenerate : doStream;
    expect(result).toBe(method === 'doGenerate' ? generated : streamed);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.contexts[0]).toBe(model);
    const received = spy.mock.calls[0]![0];
    const parts = received.prompt[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(parts[0]).toBe(plainText);
    expect(parts[1]).toEqual({ ...firstContent[1], data: bytes });
    expect(parts[1]!.data).toBe(bytes);
    expect(parts[2]).toEqual({ ...firstContent[2], data: encoded });
    const assistant = received.prompt[1]!.content as unknown as Array<Record<string, unknown>>;
    expect(assistant[0]!.data).toBe(url);
    const { prompt: _originalPrompt, ...originalSettings } = options;
    const { prompt: _receivedPrompt, ...receivedSettings } = received;
    expect(receivedSettings).toEqual(originalSettings);
    expect(received.abortSignal).toBe(options.abortSignal);
    expect(received.providerOptions).toBe(options.providerOptions);
    expect(received.tools).toBe(options.tools);
    expect(firstContent[1]!.data).toEqual({ type: 'data', data: bytes });
    expect(firstContent[2]!.data).toEqual({ type: 'data', data: encoded });
    expect(options.prompt[1]!.content).toEqual([{ type: 'file', mediaType: 'image/png',
      filename: 'original-url.png', data: { type: 'url', url }, providerOptions: { compat: { original: 'url' } } }]);
    expect(adapted.specificationVersion).toBe('v3');
    expect(adapted.provider).toBe(model.provider);
    expect(adapted.modelId).toBe(model.modelId);
    expect(adapted.supportedUrls).toBe(model.supportedUrls);
  });

  it.each([new Uint8Array([1, 2, 3]), 'AQID', new URL('https://example.test/source.jpg')])('passes already-legacy file data unchanged: %s', async (data) => {
    const { model, doGenerate } = legacyModel();
    const options = callOptions(data) as unknown as LegacyOptions;
    await (adaptLegacyLanguageModelFileData(model) as LegacyModel).doGenerate(options);
    expect(doGenerate).toHaveBeenCalledExactlyOnceWith(options);
    expect(doGenerate.mock.calls[0]![0]).toBe(options);
  });

  it('leaves native v4 and its text/reference file semantics untouched', async () => {
    const { model, doGenerate } = legacyModel();
    const native = { ...model, specificationVersion: 'v4' } as unknown as NativeModel;
    expect(adaptLegacyLanguageModelFileData(native)).toBe(native);
    for (const data of [{ type: 'reference', reference: { compat: 'file-reference' } },
      { type: 'text', text: 'Actual inline text content.' }]) {
      const options = callOptions(data);
      await native.doGenerate(options);
      expect(doGenerate.mock.calls.at(-1)![0]).toBe(options);
    }
  });

  it.each(['doGenerate', 'doStream'] as const)('rejects reference/text/malformed tagged data before %s provider I/O', (method) => {
    const { model, doGenerate, doStream } = legacyModel();
    const adapted = adaptLegacyLanguageModelFileData(model) as LegacyModel;
    for (const data of [{ type: 'reference', reference: { compat: 'file-reference' } },
      { type: 'text', text: 'Not base64.' }, { type: 'data', data: { private: 'never stringify' } },
      { type: 'url', url: 'not-a-URL-object' }]) {
      expect(() => adapted[method](callOptions(data) as unknown as LegacyOptions)).toThrowError(
        expect.objectContaining({ code: 'LEGACY_LANGUAGE_MODEL_FILE_DATA_UNSUPPORTED', isRetryable: false }),
      );
    }
    expect(doGenerate).not.toHaveBeenCalled();
    expect(doStream).not.toHaveBeenCalled();
  });

  it('keeps non-file content and arbitrary tool arguments unchanged', async () => {
    const { model, doGenerate } = legacyModel();
    const options: LegacyOptions = { prompt: [{ role: 'system', content: 'The original source.' },
      { role: 'user', content: [{ type: 'text', text: 'Original prompt.' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Original reasoning.' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'inspect',
          input: { type: 'file', data: { type: 'reference', reference: { unrelated: 'tool-argument' } } } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'inspect',
        output: { type: 'json', value: { type: 'file', data: { type: 'text', text: 'JSON evidence.' } } } }] }] };
    await (adaptLegacyLanguageModelFileData(model) as LegacyModel).doGenerate(options);
    expect(doGenerate.mock.calls[0]![0]).toBe(options);
  });

  it('maps tool-result files to existing legacy file-data/file-url forms and preserves old tool files', async () => {
    const { model, doGenerate } = legacyModel();
    const bytes = Uint8Array.from({ length: 32771 }, (_, index) => index % 256);
    const url = new URL('https://example.test/tool-figure.png');
    const legacyFile = { type: 'file-data', data: 'AQID', mediaType: 'image/png' };
    const output = { type: 'content', providerOptions: { compat: { original: true } }, value: [
      { type: 'text', text: 'Original observation.' },
      { type: 'file', mediaType: 'image/png', filename: 'tool.png', data: { type: 'data', data: bytes },
        providerOptions: { compat: { original: true } } },
      { type: 'file', mediaType: 'image/png', data: { type: 'url', url } }, legacyFile,
    ] };
    const options = { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1',
      toolName: 'inspect', output }] }] } as unknown as NativeOptions;
    await (adaptLegacyLanguageModelFileData(model) as LegacyModel).doGenerate(options as unknown as LegacyOptions);
    const received = doGenerate.mock.calls[0]![0].prompt[0]!.content as unknown as Array<{ output: typeof output }>;
    expect(received[0]!.output.value).toEqual([output.value[0],
      { ...output.value[1], type: 'file-data', data: Buffer.from(bytes).toString('base64') },
      { type: 'file-url', mediaType: 'image/png', url: url.toString() }, legacyFile]);
    expect(received[0]!.output.value[3]).toBe(legacyFile);
    expect(received[0]!.output.providerOptions).toBe(output.providerOptions);
    expect(output.value[1]).toHaveProperty('data.type', 'data');
    expect(output.value[2]).toHaveProperty('data.type', 'url');
  });

  it('rejects unsupported tool file reference/text semantics rather than silently converting them', () => {
    const { model, doGenerate } = legacyModel();
    for (const data of [{ type: 'reference', reference: { compat: 'file-reference' } },
      { type: 'text', text: 'Actual text.' }]) {
      const options = { prompt: [{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1',
        toolName: 'inspect', output: { type: 'content', value: [{ type: 'file', mediaType: 'text/plain', data }] } }] }] };
      expect(() => (adaptLegacyLanguageModelFileData(model) as LegacyModel).doGenerate(options as LegacyOptions))
        .toThrow('cannot accept file data type');
    }
    expect(doGenerate).not.toHaveBeenCalled();
  });
});
