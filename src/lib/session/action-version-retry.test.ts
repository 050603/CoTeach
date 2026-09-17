import { describe, expect, it, vi } from "vitest";
import {
  retryVersionConflict,
  SessionActionRequestError,
} from "./action-version-retry";

describe("session action version conflict recovery", () => {
  it("retains the server message for user-facing save errors", () => {
    const error = new SessionActionRequestError(
      "REVIEW_STALE",
      409,
      undefined,
      "课程内容已变更，请重新进行教师终审。",
    );

    expect(error.code).toBe("REVIEW_STALE");
    expect(error.message).toBe("课程内容已变更，请重新进行教师终审。");
  });

  it("retries with the server version and preserves the original operation", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new SessionActionRequestError("VERSION_CONFLICT", 409, 8))
      .mockResolvedValueOnce({ courseVersion: 9 });

    await expect(retryVersionConflict(send, 7)).resolves.toEqual({ courseVersion: 9 });
    expect(send.mock.calls).toEqual([[7], [8]]);
  });

  it("does not retry unrelated request failures", async () => {
    const error = new SessionActionRequestError("FORBIDDEN_ACTION", 403);
    const send = vi.fn().mockRejectedValue(error);

    await expect(retryVersionConflict(send, 7)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries an unstructured edge 400 with the same expected version", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new SessionActionRequestError("SESSION_ACTION_FAILED_400", 400))
      .mockResolvedValueOnce({ courseVersion: 8 });

    await expect(retryVersionConflict(send, 7)).resolves.toEqual({ courseVersion: 8 });
    expect(send.mock.calls).toEqual([[7], [7]]);
  });

  it("does not retry a structured invalid action response", async () => {
    const error = new SessionActionRequestError("INVALID_ACTION", 400);
    const send = vi.fn().mockRejectedValue(error);

    await expect(retryVersionConflict(send, 7)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("recovers a missing local version from the server response", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new SessionActionRequestError("EXPECTED_VERSION_REQUIRED", 428, 1))
      .mockResolvedValueOnce({ courseVersion: 2 });

    await expect(retryVersionConflict(send, undefined)).resolves.toEqual({ courseVersion: 2 });
    expect(send.mock.calls).toEqual([[undefined], [1]]);
  });

  it("bounds repeated conflicts instead of looping forever", async () => {
    const send = vi.fn((version: number | undefined) =>
      Promise.reject(new SessionActionRequestError("VERSION_CONFLICT", 409, (version ?? 0) + 1)),
    );

    await expect(retryVersionConflict(send, 3)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(send.mock.calls).toEqual([[3], [4], [5], [6], [7]]);
  });

  it("retries transient server contention with the same version", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new SessionActionRequestError("ACTION_FAILED", 500))
      .mockRejectedValueOnce(new SessionActionRequestError("REQUEST_IN_PROGRESS", 409))
      .mockResolvedValueOnce({ courseVersion: 8 });

    await expect(retryVersionConflict(send, 7)).resolves.toEqual({ courseVersion: 8 });
    expect(send.mock.calls).toEqual([[7], [7], [7]]);
  });

  it("retries a fetch transport error because the request id is idempotent", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ courseVersion: 8 });

    await expect(retryVersionConflict(send, 7)).resolves.toEqual({ courseVersion: 8 });
    expect(send.mock.calls).toEqual([[7], [7]]);
  });
});
