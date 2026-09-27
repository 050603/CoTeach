# 学生学习时间统计范围修复

2026-09-27。修复前 `loadInstanceCourse` 即使有 student readScope，仍将全班 ID 传给 `loadAiLearningTiming`；该函数的 SQL 只过滤 classroomInstanceId。随后 `scopeCourseForClaims` 保留全部 aiLearningTimingByStudent，因此学生 GET state 能收到其他学生的 effectiveDurationMs、expectedDurationMs 和 hasEvidence。全仓库该字段唯一 UI 消费者为教师 AI 学习页面。

本次仅修复三处：

1. 学生投影传入课堂中匹配本人的参与者 ID，教师继续传全班 ID。
2. SQL 在最初物化 CTE 中增加 `userId IN (...)` 参数绑定，避免聚合未授权学生历史；空列表原有提前返回保留。
3. claims scope 只保留学生自己的 timing，防止其他未提供 readScope 的旧入口泄漏。教师完整统计不变。

没有新增索引、数据库迁移或其他业务重构。

验证已完成：

```sh
pnpm exec vitest run src/lib/db/ai-learning-timing.test.ts src/lib/auth/course-scope.test.ts src/lib/auth/session-state.test.ts src/lib/db/v2-course-projection.test.ts 'src/app/api/courses/[courseId]/state/route.test.ts'
pnpm typecheck
node scripts/verify-student-state-scope.mjs
```

31 项相关单测、全量类型检查和受影响文件 ESLint 通过。覆盖两名学生互不可见、教师完整视图、无本人/无主体/空 ID 列表、原对象不修改、SQL 仅绑定请求学生。

在其他 HTTP 性能负载结束后，使用独立随机 UUID、临时 PostgreSQL 和 14,000 条历史事件执行真实验证。生产库未写入。worker 检查实际 queryRaw 绑定参数（学生只有本人，教师 40 个 ID），并核对学生聚合值与教师对应项逐字段一致。

| 隔离 PostgreSQL 对照 | 请求数 | P95 | 最大值 |
| --- | ---: | ---: | ---: |
| 仅时间统计，所有请求传全班 ID | 42 | 414 ms | 415 ms |
| 仅时间统计，40 学生本人 + 2 教师全班 ID | 42 | 22 ms | 106 ms |

完整课程投影对照为全班读取 P95 12,012 ms、约 723 MB，学生 scoped 读取 P95 592 ms、约 54.4 MB。后者包括此前已有的其他集合范围优化，不能将全部收益归因于本次 timing 修复。以上为隔离数据库结果，不代表部署后的真实 HTTP 混合负载已通过门槛。

日志：`timing-student-scope-tests.log`、`timing-student-scope-typecheck.log`、`timing-student-scope-pg.log`。运行代码和验收 worker 已冻结；未自行构建或部署。
