export function qualifyModelForProvider(model: string, providerId?: string): string {
  const trimmed = model.trim();
  const provider = providerId?.trim();

  if (!trimmed || !provider) {
    return trimmed;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const possibleProvider = trimmed.slice(0, colonIndex);
    if (/^[a-z][a-z0-9_-]*$/i.test(possibleProvider)) return trimmed;
  }

  return `${provider}:${trimmed}`;
}

export function splitModelIds(value: string): string[] {
  return value
    .split(/[,\n，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
