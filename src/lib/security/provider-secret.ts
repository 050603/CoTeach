import { decryptCredential, encryptCredential } from './credential-encryption';

/** Versioned AES-GCM envelope stored in V2 ProviderCredential.secret. */
export function encodeProviderSecret(value: string, context: string): string {
  const encrypted = encryptCredential(value, context);
  if (!encrypted) return '';
  return JSON.stringify({ version: 1, ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    iv: Buffer.from(encrypted.iv).toString('base64'), authTag: Buffer.from(encrypted.authTag).toString('base64') });
}

export function decodeProviderSecret(secret: string, context: string): string {
  if (!secret) return '';
  const envelope = JSON.parse(secret) as Record<string, unknown>;
  if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string'
    || typeof envelope.iv !== 'string' || typeof envelope.authTag !== 'string') {
    throw new Error('Unsupported provider credential envelope.');
  }
  return decryptCredential(Buffer.from(envelope.ciphertext, 'base64'), Buffer.from(envelope.iv, 'base64'),
    Buffer.from(envelope.authTag, 'base64'), context);
}
