const MODEL_ID_ALIASES: ReadonlyMap<string, string> = new Map([
  ['openai:gpt-5.6-sol', 'gpt-5.6'],
]);

export function getCanonicalModelId(providerId: string, modelId: string): string {
  return MODEL_ID_ALIASES.get(`${providerId}:${modelId}`) ?? modelId;
}

export function modelIdsMatch(providerId: string, left: string, right: string): boolean {
  return getCanonicalModelId(providerId, left) === getCanonicalModelId(providerId, right);
}

export function findModelById<T extends { id: string }>(
  providerId: string,
  models: readonly T[] | undefined,
  modelId: string,
): T | undefined {
  const canonicalModelId = getCanonicalModelId(providerId, modelId);
  return (
    models?.find((model) => model.id === canonicalModelId) ??
    models?.find((model) => modelIdsMatch(providerId, model.id, modelId))
  );
}
