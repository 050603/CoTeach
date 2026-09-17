export const QWEN_IMAGE_MODELS = [
  { id: 'qwen-image-3.0-pro', name: 'Qwen Image 3.0 Pro' },
  { id: 'qwen-image-3.0', name: 'Qwen Image 3.0' },
] as const;

export const DEFAULT_QWEN_IMAGE_MODEL_ID = QWEN_IMAGE_MODELS[0].id;

export function normalizeQwenImageModel(modelId?: string): string {
  return QWEN_IMAGE_MODELS.some((model) => model.id === modelId)
    ? modelId!
    : DEFAULT_QWEN_IMAGE_MODEL_ID;
}
