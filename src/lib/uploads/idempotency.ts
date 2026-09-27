import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { runMutationTransaction } from '@/lib/db/transaction-retry';

export class UploadRequestConflict extends Error {
  readonly code = 'UPLOAD_REQUEST_CONFLICT';
  constructor() { super('此上传请求编号已经用于其他文件或元数据，请重新选择文件上传。'); }
}
export interface UploadReceiptInput {
  userId: string;
  requestId: string;
  fingerprint: string;
}
function key(input: UploadReceiptInput): string {
  return `upload-receipt:${createHash('sha256').update(JSON.stringify([input.userId, input.requestId])).digest('hex')}`;
}
export function uploadFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function findReceipt(db: Pick<Prisma.TransactionClient, 'domainEvent'>, input: UploadReceiptInput): Promise<Prisma.JsonObject | null> {
  const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: key(input) } });
  if (!receipt) return null;
  const payload = receipt.payload as Prisma.JsonObject | null;
  if (receipt.actorId !== input.userId || payload?.fingerprint !== input.fingerprint) throw new UploadRequestConflict();
  if (!payload.response || typeof payload.response !== 'object' || Array.isArray(payload.response)) throw new Error('Invalid durable upload receipt');
  return payload.response;
}
/** Caller authenticates and authorizes the target course before consulting this receipt. */
export function readUploadReceipt(input: UploadReceiptInput): Promise<Prisma.JsonObject | null> {
  return findReceipt(prisma, input);
}
export async function persistUploadOnce<T>(
  input: UploadReceiptInput & { offeringId: string | null; response: Record<string, unknown> },
  save: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ response: Prisma.JsonObject; replayed: boolean; mutation: T | null }> {
  return runMutationTransaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key(input)}, 0))::text`;
    const previous = await findReceipt(tx, input);
    if (previous) return { response: previous, replayed: true, mutation: null };
    const mutation = await save(tx);
    const response = JSON.parse(JSON.stringify(input.response)) as Prisma.JsonObject;
    await tx.domainEvent.create({ data: {
      actorId: input.userId, offeringId: input.offeringId,
      idempotencyKey: key(input), eventType: 'UPLOAD_RECEIPT',
      payload: { requestId: input.requestId, fingerprint: input.fingerprint, response },
    } });
    return { response, replayed: false, mutation };
  });
}
