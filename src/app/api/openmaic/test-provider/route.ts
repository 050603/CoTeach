import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@openmaic/lib/server/api-response';
import { generateImage, IMAGE_PROVIDERS } from '@openmaic/lib/media/image-providers';
import { testVideoConnectivity, VIDEO_PROVIDERS } from '@openmaic/lib/media/video-providers';
import { searchWeb } from '@openmaic/lib/web-search';
import { WEB_SEARCH_PROVIDERS } from '@openmaic/lib/web-search/constants';
import type { ImageProviderId, VideoProviderId } from '@openmaic/lib/media/types';
import type { WebSearchProviderId } from '@openmaic/lib/web-search/types';
import { transcribeAudio } from '@openmaic/lib/audio/asr-providers';
import { ASR_PROVIDERS } from '@openmaic/lib/audio/constants';
import type { ASRProviderId } from '@openmaic/lib/audio/types';
import { parsePDF } from '@openmaic/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@openmaic/lib/pdf/constants';
import type { PDFProviderId } from '@openmaic/lib/pdf/types';
import { getProviderEntry, type ProviderSection } from '@/lib/openmaic-bridge/provider-config-editor';
import { validateUrlForSSRF } from '@openmaic/lib/server/ssrf-guard';
import { isLocalOllamaEmbeddingEndpoint } from '@/lib/textbook/embedding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function classifyFailure(message: string): { status: number; hint: string } {
  const value = message.toLowerCase();
  if (/401|403|unauthor|auth failed|invalid api key/.test(value)) {
    return { status: 401, hint: '鉴权失败：请检查密钥格式、账号权限以及密钥是否属于当前服务商。' };
  }
  if (/404|model not found|not found/.test(value)) {
    return { status: 404, hint: '接口或模型不存在：请检查服务地址是否包含正确版本路径，以及模型 ID 是否可用。' };
  }
  if (/429|rate limit|quota/.test(value)) {
    return { status: 429, hint: '供应商限流或额度不足：请检查账户余额并稍后重试。' };
  }
  if (/network|fetch failed|enotfound|econnrefused|timeout/.test(value)) {
    return { status: 502, hint: '无法连接供应商：请检查服务地址、网络、代理和防火墙。' };
  }
  return { status: 502, hint: '供应商拒绝了测试请求，请根据上游响应检查模型和请求参数。' };
}

function createAsrTestWav(): Buffer {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const fade = Math.min(1, index / 800, (sampleCount - index) / 800);
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 1200 * fade);
    wav.writeInt16LE(sample, 44 + index * 2);
  }
  return wav;
}

function createPdfTestDocument(): Buffer {
  const stream = 'BT /F1 18 Tf 72 720 Td (CoTeach provider test) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let content = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(content, 'ascii');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      section?: ProviderSection;
      providerId?: string;
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    if (!body.section || !body.providerId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'section and providerId are required');
    }
    const saved = await getProviderEntry(body.section, body.providerId);
    const apiKey = body.apiKey?.trim() || saved?.apiKey || '';
    const baseUrl = body.baseUrl?.trim() || saved?.baseUrl;
    const model = body.model?.trim() || saved?.defaultModel || saved?.models?.[0];

    const allowedLocalEmbedding = body.section === 'embedding'
      && baseUrl
      && isLocalOllamaEmbeddingEndpoint(body.providerId, baseUrl);
    if (baseUrl && process.env.NODE_ENV === 'production' && !allowedLocalEmbedding) {
      const ssrfError = await validateUrlForSSRF(baseUrl);
      if (ssrfError) return apiError('INVALID_URL', 403, ssrfError);
    }

    let result: { success: boolean; message: string };
    let detail: string | undefined;
    let previewUrl: string | undefined;
    if (body.section === 'asr') {
      if (body.providerId === 'browser-native') {
        return apiError('INVALID_REQUEST', 400, '浏览器原生语音识别没有服务端接口，请在支持 Web Speech API 的浏览器中使用麦克风实测。');
      }
      const provider = ASR_PROVIDERS[body.providerId as keyof typeof ASR_PROVIDERS];
      if (provider?.requiresApiKey && !apiKey) return apiError('MISSING_API_KEY', 401, '语音识别服务缺少 API 密钥');
      const transcription = await transcribeAudio({
        providerId: body.providerId as ASRProviderId,
        apiKey,
        baseUrl,
        modelId: model,
        language: 'en',
      }, createAsrTestWav());
      result = { success: true, message: '语音识别模型测试成功，服务已接收并处理 WAV 测试样本。' };
      detail = `语音识别服务 ${provider?.name || body.providerId}；模型 ${model || '默认'}；返回文本长度 ${transcription.text.length}`;
    } else if (body.section === 'pdf') {
      if (!(body.providerId in PDF_PROVIDERS)) {
        return apiError('INVALID_REQUEST', 400, `Unsupported PDF provider: ${body.providerId}`);
      }
      const providerId = body.providerId as PDFProviderId;
      const provider = PDF_PROVIDERS[providerId];
      if (provider.requiresApiKey && !apiKey) return apiError('MISSING_API_KEY', 401, 'PDF 解析服务缺少 API 密钥');
      const parsed = await parsePDF({ providerId, apiKey, baseUrl }, createPdfTestDocument());
      result = { success: true, message: 'PDF 解析模型测试成功，服务已解析一页测试文档。' };
      detail = `PDF 服务 ${provider.name}；页数 ${parsed.metadata?.pageCount ?? 1}；解析文本长度 ${parsed.text.length}`;
    } else if (body.section === 'image') {
      if (!(body.providerId in IMAGE_PROVIDERS)) {
        return apiError('INVALID_REQUEST', 400, `Unsupported image provider: ${body.providerId}`);
      }
      const providerId = body.providerId as ImageProviderId;
      const provider = IMAGE_PROVIDERS[providerId];
      if (provider.requiresApiKey && !apiKey) return apiError('MISSING_API_KEY', 401, '图像服务缺少 API 密钥');
      const generated = await generateImage(
        { providerId, apiKey, baseUrl, model },
        {
          prompt: 'A clean educational illustration of an open book and a small glowing light bulb, simple composition, no text',
          width: 512,
          height: 512,
          aspectRatio: '1:1',
        },
      );
      previewUrl = generated.base64
        ? `data:image/png;base64,${generated.base64}`
        : generated.url;
      result = previewUrl
        ? { success: true, message: '图像模型测试成功，已实际生成一张测试图片。' }
        : { success: false, message: '图像接口返回成功，但没有图片 URL 或 base64 数据。' };
      detail = `图像服务 ${provider.name}；模型 ${model || '默认'}；地址 ${baseUrl || provider.defaultBaseUrl || '默认'}`;
    } else if (body.section === 'video') {
      if (!(body.providerId in VIDEO_PROVIDERS)) {
        return apiError('INVALID_REQUEST', 400, `Unsupported video provider: ${body.providerId}`);
      }
      const providerId = body.providerId as VideoProviderId;
      const provider = VIDEO_PROVIDERS[providerId];
      if (provider.requiresApiKey && !apiKey) return apiError('MISSING_API_KEY', 401, '视频服务缺少 API 密钥');
      result = await testVideoConnectivity({ providerId, apiKey, baseUrl, model });
      detail = `视频服务 ${provider.name}；模型 ${model || '默认'}；地址 ${baseUrl || provider.defaultBaseUrl || '默认'}`;
    } else if (body.section === 'web-search') {
      if (!(body.providerId in WEB_SEARCH_PROVIDERS)) {
        return apiError('INVALID_REQUEST', 400, `Unsupported web-search provider: ${body.providerId}`);
      }
      const providerId = body.providerId as WebSearchProviderId;
      const provider = WEB_SEARCH_PROVIDERS[providerId];
      if (provider.requiresApiKey && !apiKey) return apiError('MISSING_API_KEY', 401, '搜索服务缺少 API 密钥');
      const response = await searchWeb({
        providerId,
        query: '项目式学习 教学设计',
        apiKey,
        baseUrl,
        maxResults: 1,
        signal: request.signal,
      });
      result = { success: true, message: `搜索服务返回 ${response.sources.length} 条可解析结果` };
      detail = `搜索服务 ${provider.name}；地址 ${baseUrl || provider.defaultBaseUrl || '默认'}`;
    } else if (body.section === 'embedding') {
      const keylessLocal = body.providerId === 'ollama-embedding';
      if ((!apiKey && !keylessLocal) || !baseUrl || !model) {
        return apiError('MISSING_REQUIRED_FIELD', 400, '教材向量服务需要服务地址、模型 ID，以及远程服务所需的密钥。');
      }
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, input: ['建构主义学习理论'], dimensions: 1024, encoding_format: 'float' }),
        signal: request.signal,
      });
      const payload = await response.json().catch(() => null) as { data?: Array<{ embedding?: unknown }>; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message || `向量服务返回 ${response.status}`);
      const vector = payload?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== 1024 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error(`向量服务返回错误维度；预期 1024 维，实际 ${Array.isArray(vector) ? vector.length : 0} 维。`);
      }
      result = { success: true, message: '教材向量模型测试成功。' };
      detail = `模型 ${model}；返回 1024 维有限数值向量。`;
    } else {
      return apiError(
        'INVALID_REQUEST',
        400,
        `该测试路由不支持 ${body.section}；此能力需要专用测试样本。`,
      );
    }

    if (!result.success) {
      const failure = classifyFailure(result.message);
      return apiError('UPSTREAM_ERROR', failure.status, failure.hint, `${detail}；上游响应：${result.message}`);
    }
    return apiSuccess({ message: result.message, detail, ...(previewUrl ? { previewUrl } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure(message);
    return apiError('UPSTREAM_ERROR', failure.status, failure.hint, `上游响应：${message}`);
  }
}
