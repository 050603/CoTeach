// @vitest-environment node
import { Prisma } from '@prisma/client';
import { afterEach, expect, it, vi } from 'vitest';
const transaction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: transaction } }));
import { isRetryableTransactionError, runMutationTransaction } from './transaction-retry';
const diagnostic = (code: string, detail = 'None') => `\nInvalid \`tx.classroomParticipation.update()\` invocation\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "server error", severity: "ERROR", detail: ${detail}, column: None, hint: None }), transient: false })`;
const unknown = (message: string) => new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: '6.19.3' });
afterEach(() => { vi.useRealTimers(); transaction.mockReset(); });
it.each(['40001', '40P01'])('recognizes only actual Unknown outer structured %s', code => {
  expect(isRetryableTransactionError(unknown(diagnostic(code)))).toBe(true);
});
it.each(['23505', '55P03', '57014', 'P0001'])('does not interpret user detail as retryable when outer code is %s', code => {
  const text = diagnostic(code, 'Some("PostgresError { code: \\"40P01\\", message: \\"user supplied\\" }")');
  expect(isRetryableTransactionError(unknown(text))).toBe(false);
});
it('rejects plain errors, unrelated Unknown errors, partial format and user-like embedded codes', () => {
  const valid = diagnostic('40P01');
  for (const error of [new Error(valid), { message: valid }, unknown('user says 40P01'), unknown('PostgresError { code: "40P01" }'),
    unknown(valid.replace('ConnectorError(ConnectorError', 'ChangedError(ConnectorError')),
    unknown(valid.replace('user_facing_error: None', 'user_facing_error: Some("user")')),
    unknown(valid.replace('Error occurred during query execution:\n', 'user text: ')),
    unknown(valid + '\nnot the outer diagnostic')]) expect(isRetryableTransactionError(error)).toBe(false);
});
it('keeps the existing five-attempt cap for exact Unknown deadlocks', async () => {
  vi.useFakeTimers(); const error = unknown(diagnostic('40P01')); transaction.mockRejectedValue(error);
  const pending = runMutationTransaction(async () => 'never').catch(value => value);
  await vi.runAllTimersAsync(); expect(await pending).toBe(error); expect(transaction).toHaveBeenCalledTimes(5);
});
it('returns nonmatching error identity unchanged after a single attempt', async () => {
  const error = unknown(diagnostic('23505', 'Some("code: 40P01")')); transaction.mockRejectedValue(error);
  await expect(runMutationTransaction(async () => 'never')).rejects.toBe(error); expect(transaction).toHaveBeenCalledTimes(1);
});
