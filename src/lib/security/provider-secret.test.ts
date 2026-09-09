// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { decodeProviderSecret, encodeProviderSecret } from './provider-secret';
afterEach(() => vi.unstubAllEnvs());
it('stores authenticated encrypted envelopes without plaintext and binds to provider section', () => {
  vi.stubEnv('PROVIDER_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  const secret = encodeProviderSecret('unit-test-key', 'providers:openai');
  expect(secret).not.toContain('unit-test-key');
  expect(decodeProviderSecret(secret, 'providers:openai')).toBe('unit-test-key');
  expect(() => decodeProviderSecret(secret, 'tts:openai')).toThrow();
  expect(() => decodeProviderSecret('{"version":2}', 'providers:openai')).toThrow();
  expect(decodeProviderSecret(encodeProviderSecret('', 'tts:keyless'), 'tts:keyless')).toBe('');
});
