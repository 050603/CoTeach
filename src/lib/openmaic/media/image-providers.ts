/**
 * Image Generation Service -- routes to provider adapters
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from './types';
import { generateWithSeedream, testSeedreamConnectivity } from './adapters/seedream-adapter';
import {
  generateWithOpenAIImage,
  testOpenAIImageConnectivity,
} from './adapters/openai-image-adapter';
import { generateWithQwenImage, testQwenImageConnectivity } from './adapters/qwen-image-adapter';
import { generateWithNanoBanana, testNanoBananaConnectivity } from './adapters/nano-banana-adapter';
import {
  generateWithMiniMaxImage,
  testMiniMaxImageConnectivity,
} from './adapters/minimax-image-adapter';
import { generateWithGrokImage, testGrokImageConnectivity } from './adapters/grok-image-adapter';
import {
  generateWithLemonadeImage,
  testLemonadeImageConnectivity,
} from './adapters/lemonade-image-adapter';

export { IMAGE_PROVIDERS } from './image-provider-config';

export async function testImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  switch (config.providerId) {
    case 'seedream':
      return testSeedreamConnectivity(config);
    case 'openai-image':
      return testOpenAIImageConnectivity(config);
    case 'qwen-image':
      return testQwenImageConnectivity(config);
    case 'nano-banana':
      return testNanoBananaConnectivity(config);
    case 'minimax-image':
      return testMiniMaxImageConnectivity(config);
    case 'grok-image':
      return testGrokImageConnectivity(config);
    case 'lemonade':
      return testLemonadeImageConnectivity(config);
    default:
      return {
        success: false,
        message: `Unsupported image provider: ${config.providerId}`,
      };
  }
}

export async function generateImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  // HTTP requests retry inside adapters; completed operations never restart here.
  try {
    switch (config.providerId) {
      case 'seedream':
        return await generateWithSeedream(config, options);
      case 'openai-image':
        return await generateWithOpenAIImage(config, options);
      case 'qwen-image':
        return await generateWithQwenImage(config, options);
      case 'nano-banana':
        return await generateWithNanoBanana(config, options);
      case 'minimax-image':
        return await generateWithMiniMaxImage(config, options);
      case 'grok-image':
        return await generateWithGrokImage(config, options);
      case 'lemonade':
        return await generateWithLemonadeImage(config, options);
      default:
        throw new Error(`Unsupported image provider: ${config.providerId}`);
    }
  } catch (error) {
    if (error instanceof Error) throw Object.assign(error, { isRetryable: false });
    throw Object.assign(new Error(String(error)), { isRetryable: false });
  }
}

export function aspectRatioToDimensions(
  ratio: string,
  maxWidth = 1024,
): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h) return { width: maxWidth, height: Math.round((maxWidth * 9) / 16) };
  return { width: maxWidth, height: Math.round((maxWidth * h) / w) };
}
