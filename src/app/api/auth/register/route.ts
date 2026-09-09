// Legacy account routes were retired by the V2 account migration.
export async function POST() {
  return Response.json({ code: "V2_AUTH_REQUIRED", message: "请使用课程平台登录与注册入口" }, { status: 410 });
}

export const GET = POST;
