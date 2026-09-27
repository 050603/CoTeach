# 进度回执及旧队列兼容（2026-09-27）

学习进度原先只合并完成场景集合，丢回执重试仍会重复更新活跃时间、workspace/课堂版本并新增 `UPDATE_STUDENT_PROGRESS`。本轮增加持久化回执：同一请求精确重放，不改变后续已保存状态；同 ID 异内容返回 409。没有新增数据库迁移。

## 契约

- 播放器入队时生成并保存 `requestId`；重试与刷新继续使用原 ID。部署前已有队列缺少该字段时，发送使用既有 outbox `entry.id`，不在重试时生成新 ID。共享 outbox 发送函数新增第二个参数传递此 ID，原单参数调用兼容。
- POST 对受支持原始请求字段按固定顺序计算指纹，排除服务端 `lastActiveAt`、当前历史和动态合并结果。无 ID 的旧客户端使用原始请求指纹派生 `legacy-*` ID：相同播放上报视为同一操作，不重复记录活跃时间；内容变化产生独立操作。
- 锁后单条查询读取当前用户状态、角色、会话版本、本人选课与课堂归属及回执。当前授权撤销优先拒绝，即使回执已存在。有效授权下允许结课后重放已提交回执，新的结课写入返回 409。
- DomainEvent 固定幂等 key；`payload.requestId`、`fingerprint`、`response` 与进度、阶段百分比、课堂版本同事务提交。回放不写入、不增加版本、不重复通知。原低优先级课程准入和 advisory → 行锁 → 新鲜读取顺序保留。
- POST 保持 `{success:true,data:{progress}}`，`progress` 精简为身份、场景/提纲完成集、位置、总数、模型版本、掌握状态、首次提交活跃时间；`payload.response` 等于首次 `data.progress`。聊天、测验和适应性历史保留在 workspace，GET 契约不变。当前唯一应用 POST 调用方仅检查 HTTP 成功，不读取返回历史。

## 实际验证

```sh
pnpm exec vitest run src/lib/courses/ai-progress-service.test.ts src/app/api/openmaic/progress/route.test.ts src/lib/browser/learning-outbox.test.ts src/components/openmaic-bridge/student-stage-host.test.tsx
pnpm typecheck
OPENPBL_VERIFY_CONCURRENCY_ONLY=1 node scripts/verify-research-database.mjs
```

4 文件、**52 测试通过**，覆盖播放器失败重挂时完整请求和 ID 一致、旧队列升级、原始指纹不受合并结果变化影响、精简回执与历史保留、授权撤销、异常不发布。日志见 progress-receipt-tests.log（本机证据：`progress-receipt-tests.log`）。全仓类型检查退出 0，见 progress-receipt-typecheck.log（本机证据：`progress-receipt-typecheck.log`）；上述运行文件、测试及两份数据库工具 ESLint `--max-warnings 0` 通过。

progress-receipt-concurrency.log（本机证据：`progress-receipt-concurrency.log`） 记录真实隔离 PostgreSQL 的结果：

- 40 人每人同时发送两份相同请求，仅新增 40 份回执；40 次同 ID 改内容均冲突。
- 新进度保存后重放旧回执，返回原结果，数据库当前索引、活跃时间及 workspace 完全不变。
- **实际重启本次隔离 PostgreSQL 容器**后，40 人回执继续精确重放，没有新增事件或课堂版本。
- 结课后 40 份旧回执可重放，新 ID 均拒绝；账户禁用、角色变化、会话撤销、退课、外教学班归属拒绝已提交回执。
- 原有 40 人草稿 CAS/归档交错、80 场景合并、测验及完整 tutor 原始输出、各写入点故障回滚检查全部通过。日志中的 `isolated CTE rollback` 是预期故障注入。

旧隔离工具使用 tmpfs 和动态端口，首次容器重启验证因测试存储/端口不能跨重启保留而失败；保留 progress-receipt-tmpfs-restart-failure.log（本机证据：`progress-receipt-tmpfs-restart-failure.log`）。本轮仅为 `CONCURRENCY_ONLY` 改为随机 nonce 独占 Docker volume 与固定临时 loopback 端口，重启前核对名称、数据库 nonce 和端口；finally 删除本次容器与卷，已确认清理。其他工具分支仍沿用原模式。正式数据库、容器和端口未操作。

## 容量限制

本轮 14,400 历史事件及长 AI 回答的单批混合实测：测验 P95 **3332ms**、进度 **3070ms**、草稿 **3342ms**，单次投屏确认 **86ms**。学生写入仍超过 2 秒目标；投屏仅一条样本，不构成 P95 证明。数据一致性通过不代表容量通过。本轮未构建、部署或完成真实 HTTP 持续负载验收。
