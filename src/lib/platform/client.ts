export class PlatformSessionExpiredError extends Error {
  constructor() {
    super("登录状态已失效，请重新登录");
    this.name = "PlatformSessionExpiredError";
  }
}

export async function readPlatformResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403 && data?.code === "UNAUTHORIZED") {
    throw new PlatformSessionExpiredError();
  }
  return data;
}

export function redirectExpiredTeacherSession(reason: unknown): boolean {
  if (!(reason instanceof PlatformSessionExpiredError)) return false;
  const target = `/teacher/login?reason=session-expired&redirect=${encodeURIComponent(location.pathname)}`;
  location.assign(target);
  return true;
}

export async function teacherPlatformFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401 && typeof window !== "undefined") {
    const redirect = `${location.pathname}${location.search}`;
    location.replace(`/teacher/login?reason=session-expired&redirect=${encodeURIComponent(redirect)}`);
  }
  return response;
}
