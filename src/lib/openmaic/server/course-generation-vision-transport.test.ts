import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { getModel } from '../ai/providers';
import { runWithCourseGenerationLlmContext } from '@/lib/course-generation/llm-concurrency';
import { createCourseGenerationAiCall } from './course-generation-ai-call';

vi.mock('@/lib/llm/classroom-capacity', () => ({
  withClassroomAiCapacity: (fn: () => Promise<unknown>) => fn(),
}));

type ImageRequestPart = {
  type: string;
  image_url?: { url: string };
};
type CapturedRequest = {
  model: string;
  max_tokens: number;
  thinking: { type: string };
  reasoning_effort: string;
  messages: Array<{ role: string; content: string | ImageRequestPart[] }>;
  response_format?: { type: string };
};

function response(stream: boolean): Response {
  const text = '{"elements":[]}';
  if (!stream) return new Response(JSON.stringify({
    id: 'image-transport', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  }), { headers: { 'content-type': 'application/json' } });
  const chunks = [
    { delta: { content: text }, finish_reason: null },
    { delta: {}, finish_reason: 'stop' },
  ].map((choice) => `data: ${JSON.stringify({
    id: 'image-transport', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, ...choice }],
  })}\n\n`).join('');
  return new Response(`${chunks}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

describe('course source-image vision HTTP transport', () => {
  it.each([
    { format: 'jpeg' as const, streamResponse: false },
    { format: 'jpeg' as const, streamResponse: true },
    { format: 'png' as const, streamResponse: false },
    { format: 'png' as const, streamResponse: true },
  ].flatMap((scenario) => [
    { ...scenario, baseUrl: undefined },
    { ...scenario, baseUrl: 'https://compatible.example.test/v1' },
  ]))('preserves $format MIME and every image byte for streaming=$streamResponse and baseUrl=$baseUrl', async ({ format, streamResponse, baseUrl }) => {
    const bytes = await sharp({ create: {
      width: 19, height: 11, channels: 3, background: '#e3f2ff',
    } }).toFormat(format).toBuffer();
    const src = `data:image/${format};base64,${bytes.toString('base64')}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(streamResponse));
    const { model } = getModel({ providerId: 'deepseek', modelId: 'deepseek-v4.1-flash',
      apiKey: 'test-key', fetchImpl, baseUrl });
    const call = createCourseGenerationAiCall({ model, vision: true, source: 'source-image-content',
      streamResponse, responseFormat: 'json', maxOutputTokens: 131072,
      thinking: { mode: 'enabled', effort: 'high' } });

    expect(await runWithCourseGenerationLlmContext(() => call('Return JSON.', 'Use the original source figure.',
      [{ id: 'source-figure', src }]), { onCallUsage: vi.fn() })).toBe('{"elements":[]}');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as CapturedRequest;
    expect(body).toMatchObject({ model: baseUrl ? 'deepseek-v4.1-flash' : 'deepseek-flash',
      max_tokens: 131072, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    if (baseUrl) expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${baseUrl}/chat/completions`);
    expect(body.response_format).toEqual({ type: 'json_object' });
    const userContent = body.messages.find((message) => message.role === 'user')!.content;
    expect(Array.isArray(userContent)).toBe(true);
    const images = (userContent as ImageRequestPart[]).filter((part) => part.type === 'image_url');
    expect(images).toHaveLength(1);
    expect(images[0]!.image_url!.url).toBe(src);
    const transmitted = Buffer.from(images[0]!.image_url!.url.split(',', 2)[1]!, 'base64');
    expect(transmitted).toEqual(bytes);
    expect(await sharp(transmitted).metadata()).toMatchObject({ format, width: 19, height: 11 });
  });
});
