# 浏览器过程记录与进度重放对账补强

2026-09-27。本轮仅修改验收工具，不改运行代码，不构建或部署。

主入口 `scripts/verify-classroom-capacity.mjs` 已接入独立只读模块 `scripts/verify-capacity-browser-records.mjs`：

- 重启、结课后的进度重放分开执行；在没有浏览器并发写入的窗口，比较课堂 runtimeConfig/updatedAt、全体学生 workspace/version/updatedAt/lastActiveAt、参与记录阶段进度，以及课堂 DomainEvent 总数与各学生进度事件数。先完成普通 action 回执或结课重新进入，再开始快照，避免把合法其他行为误判为进度重放写入。
- 每条进度回执核对固定幂等键、原始输入 fingerprint、actor/participation/offering/researchKey、scope/stageKey 及首次 ACK 完整播放字段。
- 浏览器交互事件增加 researchKey、stage/source、actorId、逻辑 conversationId 核验。
- 自动批审阅核对稳定 AiTask ID、归属、输入/指纹/最终回执；原始输出逐 attempt 校验 SHA256、长度、验证状态、token 与稳定事件 ID；最终 policy 必须唯一且与完整决策一致。此前失败尝试的原始记录可以保留，不能冒充当前尝试。
- 新鲜审阅确认的段落必须有持久审阅 checkpoint 和对应审计事实。只有 ALL_ALREADY_REVIEWED 才允许零原始输出，而且所有目标段落必须有早于本任务启动的版本 4 checkpoint 或合法历史评论锚点。
- 正向评论必须保留初始 system 锚点、assistant 原文、各自 companion-message 审计事实，以及关联 task 的 comment 事实。后续正常已读或回复不会导致误判。

验证：

```sh
node --test scripts/verify-capacity-browser-records.test.mjs scripts/verify-capacity-document-comments.test.mjs
pnpm exec eslint scripts/verify-capacity-browser-records.mjs scripts/verify-capacity-browser-records.test.mjs scripts/verify-classroom-capacity.mjs --max-warnings 0
node --check scripts/verify-classroom-capacity.mjs
```

36 项通过（新增模块 23 项、既有单段评论 13 项），ESLint 与主脚本语法检查通过。测试日志见 `browser-records-tests.log`。包含丢失/篡改/重复原始输出、错误任务/归属、缺失决策/检查点/双消息事实、合法 no-comment、历史复用、模型首次非法后修复、旧失败尝试保留，以及进度回执和静默写入检测。

本轮未运行生产全链路或新增数据库 fixture；以上工具补强不代表 42 人性能验收通过。真实自动批审阅、重启和结课重放的数据库结果需由下一轮主验收运行记录。性能门槛与质量失败规则保持原逻辑。
