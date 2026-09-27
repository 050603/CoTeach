# 主观题批阅失败诊断与完整事实留存

2026-09-27。原始失败证据：`test-results/capacity/capacity-ba2a10ae-919b-4d91-933e-43649985615e/report.json`。

该次两个学生的原答案与提交/批阅终态都已正确入库。`6b93e7ea…` 于 18:39:12.141Z 提交、18:39:20.592Z 成功批阅（6/6）；`9298be7b…` 于 18:39:12.139Z 提交、18:40:00.961Z 保存 failed（约 48.82 秒）。失败不是 HTTP 错误，但属于业务失败，不能算验收通过。

只读查询该测试 offering：AiTask 与 AiInteractionEvent 均为零。旧 finishGrading 的模型解析/调用/评分解析异常都被通用 catch 吞掉；callLLM 没有此路径的数据库埋点，末次调用失败亦不记录日志。因此历史事实不足以准确判断这次是供应商超时、传输错误还是输出解析错误。未重试该旧 fixture，未补造历史原文。

本次运行修复只涉及 `src/app/api/knowledge-lecture/route.ts` 和新增 `src/lib/courses/knowledge-lecture-grading.ts`：

- 每个题目每次显式批阅生成独立 callAttemptId，调用前持久化 request（完整原答案、系统提示与评分提示）。SDK maxRetries=0，与显式 retry-grading 的独立证据对应。
- 有模型返回时保留未经截断的完整 output.text、SHA256、长度、modelId；包括无法解析的输出。显示反馈现有 1500 字限制不会再丢失完整原文。
- terminal 记录 success/failed/cancelled、耗时与固定安全错误码。分类包括模型配置、非法 JSON、非法分数、供应商超时、限流/容量、取消和其他供应商错误；不保存可能含凭据/URL 的异常全文。
- request 与 raw/terminal 使用既有 durable audit outbox。取消后的事实保存不依赖已中止的 HTTP signal。数据库暂时不可用时同步 fsync 文件；数据库和文件都不能留存时返回失败，不确认未留存的批阅结果。
- 原答案、已成功批阅保护与结束课堂后完成已受理批阅逻辑保持原有窄事务；最终 workspace、课堂版本及 KNOWLEDGE_QUIZ_GRADED 事件仍原子提交。模型事实和业务最终事件通过 attemptId/questionId 关联。重试新增事实，不覆盖之前失败。
- 专用验收模块 `scripts/verify-capacity-grading-records.mjs` 按学生/attempt 对账，独立于 tutor/document 的 requestId 与 conversation，返回失败尝试、raw、terminal 数量；最终分数须匹配成功模型决策及已提交 DomainEvent。

验证命令：

```sh
pnpm exec vitest run src/lib/courses/knowledge-lecture-grading.test.ts src/app/api/knowledge-lecture/route.test.ts src/lib/ai-collaboration/audit-outbox.test.ts
node --test scripts/verify-capacity-grading-records.test.mjs
node scripts/verify-knowledge-grading-audit.mjs
pnpm typecheck
```

40 项 Vitest 用例、10 项 Node 对账用例通过；受影响文件 ESLint 通过。日志为 `grading-audit-tests.log`、`grading-records-tests.log`、`grading-audit-typecheck.log`。

隔离 PostgreSQL 工具仅使用随机 nonce 容器和随机 loopback 端口，生成最小表结构，不读取正式数据库凭据、不执行完整迁移、不调用真实供应商。`grading-audit-pg.log` 验证：

- 40 人实际服务 helper 并发（确定性本地模型）：39 次成功、1 次非法 JSON，完整原文/哈希/研究归属匹配；闭课后重试成功且旧事实、40 份原始答案不可变。
- 真实 DomainEvent INSERT 异常使最终分数、workspace、课堂版本及业务事件一起回滚，已经留存的模型事实保留；修复后同结果可以完成提交。
- 真实 AiInteractionEvent INSERT 异常触发磁盘 outbox；修复后补齐 request/raw/terminal，模拟 COMMIT 后未 unlink 的重复补写没有重复记录。
- 新生产只读对账 helper 已直接核对上述 40 人真实 PostgreSQL 行。

尚未验证：新版本部署后的真实供应商成功率与 42 人混合负载延迟。上述隔离成功不替代正式容量验收，也无法追溯旧 fixture 丢失的原文与错误。
