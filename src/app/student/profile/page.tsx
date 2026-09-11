"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, UserRound } from "lucide-react";
import { StudentShell } from "@/components/platform/student-shell";
import { PlatformLoading } from "@/components/platform/platform-feedback";

type StudentIdentity = { role: string; displayName?: string; username?: string };

export default function StudentProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<StudentIdentity | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/platform/auth/student-profile", { cache: "no-store", headers: { "X-OpenPBL-Role": "student" }, signal: controller.signal })
      .then(async response => {
        if (response.status === 401 || response.status === 403) { router.replace("/student/login"); return; }
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (data.user?.role !== "student") { router.replace("/student/login"); return; }
        setUser(data.user);
        setError(false);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [router, retry]);
  return <StudentShell>
    <header className="pbl-page-heading"><div><p className="text-xs tracking-widest text-[var(--pbl-student)]">学生账号</p><h1 className="mt-3 text-3xl font-semibold">个人中心</h1></div></header>
    {error ? <div role="alert" className="mt-10">个人信息加载失败。<button className="ml-4 min-h-11 underline" onClick={() => setRetry(value => value + 1)}>重新加载</button></div> : !user ? <PlatformLoading label="正在加载个人信息…" /> : <section className="pbl-student-profile" aria-label="学生个人信息">
      <div className="pbl-student-profile-identity"><span className="pbl-student-profile-avatar" aria-hidden="true">{user.displayName?.trim().charAt(0) || <UserRound />}</span><div><span className="text-xs text-[var(--pbl-student)]">学生</span><h2 className="mt-2 text-2xl font-semibold">{user.displayName || "同学"}</h2></div></div>
      <dl><div><dt>姓名</dt><dd>{user.displayName || "未设置"}</dd></div><div><dt>登录账号</dt><dd>{user.username || "未设置"}</dd></div><div><dt>账号身份</dt><dd>学生</dd></div></dl>
      <Link href="/student?all=1" className="pbl-student-profile-link"><BookOpen size={20}/><div><strong>我的课程</strong><p>查看已加入的课程，继续学习任务</p></div><ArrowRight size={18}/></Link>
    </section>}
  </StudentShell>;
}
