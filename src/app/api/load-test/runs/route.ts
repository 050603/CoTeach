import { authorizeLoadTestRequest } from "@/lib/load-test/authorization";

export const runtime = "nodejs";

// V1 fixtures and cascade teardown cannot safely operate on V2 research records.
// Use the disposable-database V2 verification runner until load fixtures migrate.
export async function POST(request: Request) {
  const denied = authorizeLoadTestRequest(request);
  if (denied) return denied;
  return Response.json({
    code: "V1_LOAD_TEST_RETIRED",
    message: "旧版压测数据接口已停用；请使用隔离数据库 V2 验证脚本。",
  }, { status: 410 });
}
