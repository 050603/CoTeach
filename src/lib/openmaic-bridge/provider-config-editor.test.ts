// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ first: vi.fn(), create: vi.fn(), update: vi.fn(), list: vi.fn(), remove: vi.fn(), lock: vi.fn(), reload: vi.fn() }));
vi.mock('@/lib/db/client', () => {
  const tx = { providerCredential: { findFirst: mocks.first, create: mocks.create, update: mocks.update, findMany: mocks.list, deleteMany: mocks.remove }, $queryRaw: mocks.lock };
  return { isProviderDatabaseConfigured: () => true, providerPrisma: { ...tx, $transaction: async (fn: (value: typeof tx) => unknown) => fn(tx) } };
});
vi.mock('@openmaic/lib/server/provider-config', () => ({ clearServerProviderConfigCache: vi.fn(), initializeServerProviderConfig: mocks.reload }));
import { saveProviderEntry, getProviderEntry, listProviders, deleteProviderEntry } from './provider-config-editor';
import { decodeProviderSecret, encodeProviderSecret } from '@/lib/security/provider-secret';
beforeEach(() => { vi.clearAllMocks(); mocks.first.mockResolvedValue(null); });
it('creates encrypted V2 credentials scoped to global provider and section under a database lock', async () => {
  await saveProviderEntry('providers', 'openai', { apiKey: 'test-only-key', models: ['test-model'] });
  const data = mocks.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ ownerId: null, name: 'providers', provider: 'openai', status: 'ACTIVE', config: { models: ['test-model'] } });
  expect(decodeProviderSecret(data.secret, 'providers:openai')).toBe('test-only-key');
  expect(mocks.lock).toHaveBeenCalled(); expect(mocks.reload).toHaveBeenCalled();
});
it('retains encrypted keys on empty input and merges saved config', async () => {
  mocks.first.mockResolvedValue({ id: 'credential', secret: encodeProviderSecret('retained', 'tts:voice'), config: { defaultVoice: 'voice-a' } });
  await saveProviderEntry('tts', 'voice', { apiKey: '', enabled: false });
  const data = mocks.update.mock.calls[0][0].data;
  expect(decodeProviderSecret(data.secret, 'tts:voice')).toBe('retained'); expect(data.config).toEqual({ defaultVoice: 'voice-a', enabled: false });
});
it('reads V2 fields and excludes user-owned secrets from global operations', async () => {
  const row = { name: 'providers', provider: 'openai', secret: encodeProviderSecret('read-key', 'providers:openai'), config: { models: ['model'] } };
  mocks.first.mockResolvedValue(row); mocks.list.mockResolvedValue([row]);
  expect(await getProviderEntry('providers', 'openai')).toEqual({ apiKey: 'read-key', models: ['model'] });
  expect(await listProviders('providers')).toEqual({ openai: { apiKey: 'read-key', models: ['model'] } });
  await deleteProviderEntry('providers', 'openai');
  expect(mocks.remove).toHaveBeenCalledWith({ where: { ownerId: null, name: 'providers', provider: 'openai' } });
});
