/** Normalize Azure portal inference URLs for @ai-sdk/azure. */
export function normalizeAzureBaseUrl(baseUrl?: string): string | undefined {
  const value = baseUrl?.trim();
  if (!value) return undefined;

  const url = new URL(value);
  url.search = '';
  url.hash = '';

  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(?:chat\/completions|responses)$/i, '');
  path = path.replace(/\/deployments\/[^/]+$/i, '');

  if (url.hostname.endsWith('.openai.azure.com')) {
    path = path.replace(/\/v1$/i, '');
    if (!path) path = '/openai';
  }

  url.pathname = path || '/';
  return url.toString().replace(/\/$/, '');
}
