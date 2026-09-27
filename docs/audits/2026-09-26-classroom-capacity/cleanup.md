# 验收自建数据清理

清理入口：[cleanup-capacity-run.mjs](../../../scripts/cleanup-capacity-run.mjs)。**最终运行未结束、未完成新备份与隔离恢复时，不执行本页命令。** 只处理主任务已确认结束的单个 UUID，保留原报告、对账结果及恢复证据，不批量按前缀删除。

默认是 dry-run，只有 `--execute` 才删除数据库及文件。数据库在 Serializable 事务内先核对归属、发现外键依赖、拒绝所有跨课程/非测试引用，再按依赖顺序删除。上传文件需在数据库删除后核对安全路径与 SHA，课堂文件路径从严格 runId 和类型构造；不信任报告中的任意路径。

## 主课堂 runner

用户名必须为 `capacity-<完整UUID>-<数字>`，课程与模板标题必须精确为 `并发验收 <runId>`，课堂文件标识只能为 `<runId>-lesson`。

`passed` 报告必须包含 `per-student-database-file-reconciliation=通过`。`failed` 或 `partial` 即使有专项通过，也必须显式使用 `--abort-run=<完整runId>`；该参数只确认终止运行可清理，不修改报告结论。

```bash
set -euo pipefail
capacity_cleanup_run_id='capacity-填写完整UUID'
capacity_cleanup_report="test-results/capacity/$capacity_cleanup_run_id/report.json"
# failed / partial：先审阅 dry-run 输出，确认每类数量与该运行匹配。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --abort-run="$capacity_cleanup_run_id"
# 已确认 dry-run、最终备份和恢复证据后，才执行同一 UUID。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --abort-run="$capacity_cleanup_run_id" --execute
```

已对账通过的 `passed` 运行省略 `--abort-run`；其余步骤相同。不要把 `partial` 改写为 `passed`。

## 投屏混合负载探针

[verify-projection-http-contention.mjs](../../../scripts/verify-projection-http-contention.mjs) 的历史报告没有 `kind` 字段。必须显式选择 `--kind=projection-contention`，工具不会猜测或改写历史报告：

```bash
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --kind=projection-contention --abort-run="$capacity_cleanup_run_id"
# 审阅这一 UUID 的 dry-run 后再执行。
node scripts/cleanup-capacity-run.mjs "$capacity_cleanup_report" \
  --kind=projection-contention --abort-run="$capacity_cleanup_run_id" --execute
```

仅接受已完成的 `measured`、`latency-failed`、`failed` 报告；三种情况均要求完整 `--abort-run`。必须有有效且不早于开始时间的 **`finishedAt`**，不能用 `endedAt` 或当前时刻补造终止信息。

该分支要求 42 个唯一用户 UUID；数据库用户名严格为 `<runId>-projection-0` 至 `-projection-41`，ID 与清单索引对应，前 2 人为教师、后 40 人为学生。课程和模板标题精确为 `投屏混合验收 <runId>`，章节标题为 `独立混合锁验收`，课程、章节、活动、场次、模板、首位教师所有权及模板课堂引用全部相符，课堂文件标识固定为 `<runId>-projection-load`。依赖发现若带入另一个课程、章节、活动、模板、场次或非清单账号，整笔清理拒绝。

只兼容已核对的探针清单形状，包括最早没有 `heartbeats/includeState/modes` 字段且具有精确历史 `workload` 文本的版本。未知形状、错标题、其他 run 的 UUID、角色错位、用户清单重复、活跃报告均拒绝，不通过放宽前缀绕过。

## 证据与验证范围

`--execute` 成功后，同目录 `cleanup.json` 保存 runId、kind、逐表数量、上传清单及数据库/文件清理结果。数据库已删但文件阶段中断时保留该回执；原 UUID 重试会先确认上传没有被重新引用，再完成文件清理。不删除 `report.json`、对账报告、备份或运行日志。

2026-09-27 离线验证：11 项工具测试、ESLint 与语法检查通过；8 份真实投屏历史报告仅在本机执行 `validateReport` 校验通过，原报告未改。**尚未对这些探针执行数据库 dry-run 或实际删除**，数据库现场归属仍需在最终恢复后逐 UUID 核对。
