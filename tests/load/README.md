# 第一阶段课堂并发验收

当前 V2 数据结构使用以下工具；旧版 `/api/load-test/runs` 返回 410，旧 Compose/k6 命令不再是可执行验收入口。

```bash
# 小规模真实 HTTP 冒烟（同样创建仅属于本次运行的测试数据）
CAPACITY_CONNECT_HOST=172.16.185.157 CAPACITY_STUDENTS=2 CAPACITY_MINUTES=0 CAPACITY_REAL_AI=1 pnpm exec tsx scripts/verify-classroom-capacity.mjs

# 正式维护窗口：2 位教师、40 位学生，120 分钟，含真实 AI 与语音
CAPACITY_CONNECT_HOST=172.16.185.157 CAPACITY_STUDENTS=40 CAPACITY_MINUTES=120 CAPACITY_REAL_AI=1 CAPACITY_RESTART_SERVICE=1 \
  pnpm exec tsx scripts/verify-classroom-capacity.mjs

# 不接触正式库的真实 PostgreSQL 并发与事务恢复验证
OPENPBL_VERIFY_CONCURRENCY_ONLY=1 node scripts/verify-research-database.mjs

# 短测：100 次投屏、42 个实际 WebSocket；分别报告实践负载与额外跨阶段压力
CAPACITY_CONNECT_HOST=172.16.185.157 pnpm exec tsx scripts/verify-projection-http-contention.mjs

# 隔离数据库：批注/无批注的完整原文、决策、幂等和失败回滚
OPENPBL_VERIFY_REVIEW_ONLY=1 node scripts/verify-research-database.mjs
```

保留现有域名 `https://coteach.cn`，默认把 HTTP、WebSocket 和浏览器连接固定到本机反向代理 `127.0.0.1`，不使用公网 DNS 路径。用 `CAPACITY_CONNECT_HOST=172.16.185.157` 指定本机校园内网地址；连接地址必须为私有或回环 IP。可用 `CAPACITY_BASE_URL` 指定其他内网入口。数据库通过本机 `deploy/secrets/database_url.txt` 加载，可用 `CAPACITY_DATABASE_URL` 指定隔离环境；不要把凭据放进报告、命令参数或共享日志。课堂文件写入本机 `.openpbl-data/classrooms`，工具适用于当前宿主部署。负载机在宿主服务器上，经校园内网地址请求反向代理；报告验证服务器和应用容量，不代表师生终端至服务器之间的 Wi-Fi 覆盖与丢包情况。

每次生成独立 UUID 课程、教师与学生，真实登录、前测/问卷、课堂进入、学习测验与进度、文档保存、两次最终归档、集中上传、展示评价与后测。持续负载分为 AI 知识学习和文档实践各60分钟：前半程每15秒读取学习进度、每分钟读取真实课件；后半程40名学生每5秒保存一次。全程42用户每10秒心跳，42个WebSocket持续订阅，15秒投屏更新必须送达所有身份。学习阶段每10秒读取课堂快照并写学习心跳，实践阶段每5秒读取快照、每分钟写实践事件。授课媒体按真实片段时长持续下载并核验；投屏操作分散在整个5秒请求周期内。逐学生核验保存内容、版本、每次已确认保存回执的正文 SHA-256 和归档 SHA-256。真实40人文档AI集中请求期间同时运行5秒自动保存和状态刷新，在学习半程完成后再进行一轮40人文档AI。默认每份协议草稿约2000字（约6KB），`CAPACITY_DOCUMENT_REPEATS=30..1000`可调整文本规模；报告记录实际字节数。AI请求单独统计并核对完整任务、消息、原始模型输出与审计归属。服务明确标记可重试的429/503/504最多重试一次，原requestId和正文不变，总期限60秒；原失败计入错误率，非流式文档AI首个可用答案耗时包含重试和等待。

真实AI模式先生成供应商语音并上传本次课程，40个独立浏览器上下文（每10人一个Chromium进程）同时打开真实学生课件、点击讲解，持续至少3分钟观察原生Audio解码及播放时间推进；小规模冒烟观察10秒。测试机每个浏览器进程使用独立实时PulseAudio输出，避免宿主共享音频输出的并发限制；不修改原生播放时间、下载或解码。此方案仅影响测试机音频输出，自动清理，不改变系统默认声卡。这项浏览器播放证据与上述120分钟协议负载分别报告，不能把协议时长写成40个浏览器连续播放120分钟。

报告位于 `test-results/capacity/<runId>/report.json`。只有完整人数、时长、真实 AI、应用重启恢复、数据对账和性能门槛全部满足，结果才能标为 `passed`；缩小运行标记 `partial`，故障保留 `failed` 现场。工具同时以真实浏览器校验投屏渲染、观察教师只读与接管、离线60秒后10秒内恢复；长压测后 `CAPACITY_RESTART_SERVICE=1` 会实际重启本机 `openpbl.service` 并核对保存回执及重连。进度在初次、重启后、结课后重放同一请求，核对唯一过程事实和完整原回执，并验证纯重放不改变数据库版本或活跃时间。

文档与两轮集中上传使用稳定请求标识并验证重复回执：普通附件约1.6MiB/人；实际“提交本地成果”入口使用1–2MiB/人，验证首次201、重放200、同编号换内容409、版本不额外递增，全部逐一下载核对SHA-256。每位学生还以真实模型请求一次针对明确矛盾的段落审阅，以2并发后台队列单独统计耗时。完整原文、判断依据和任务回执必须留存；有评论时核对系统锚点、评论及审计记录。合法且完整留存的“不评论”记为独立模型质量未通过，让持续容量测试继续，最后仍计入未通过；缺失过程记录立即失败。

另以两个真实学生浏览器验证编辑、服务器回执、刷新、断网60秒期间本机草稿、关闭页面后重新打开续传、AI回答期间继续编辑。每个浏览器还必须实际完成至少一次自动批量审阅，不能以没有触发请求代替通过。恢复后检查学习事件、协作事件和审阅的本机队列清空，逐条对账真实任务、原文、决策、评论与审计事实。旧页面及新页面的完整请求/回执分别留证；已有 mock 浏览器故障用例见 `e2e/classroom-reliability.spec.ts`，与这些真实入口检查分开报告。

开跑及运行中每分钟验证监测可读、数据库/AI/待补写指标有效、备份恢复点不超过15分钟，并检查磁盘与可用内存；异常停止负载并保存现场。数据核对工具以只读数据库连接执行：

```bash
node scripts/verify-capacity-files.mjs test-results/capacity/<runId>/report.json
node scripts/verify-capacity-ai-records.mjs test-results/capacity/<runId>/report.json
```

清理先 dry-run，再检查计划：

```bash
node scripts/cleanup-capacity-run.mjs test-results/capacity/<runId>/report.json
node scripts/cleanup-capacity-run.mjs test-results/capacity/<runId>/report.json --execute
```

失败或缩小运行需显式添加 `--abort-run=<完整runId>`。清理器校验 UUID、账号前缀及跨课程外键，只删除该运行的数据与文件，保留原报告和清理证据。不得用旧版级联清理器处理 V2 研究记录。

### 失败夹具中的文档浏览器专项

需要单独诊断文档恢复时，可对明确指定的本次失败 UUID 运行：

```bash
CAPACITY_CONNECT_HOST=172.16.185.157 node scripts/verify-capacity-document-resume.mjs capacity-<完整UUID>
```

工具校验测试用户命名、课堂归属与原始草稿版本，使用短时内存凭据，保留原失败报告，将后续写入记到独立的 `document-resume-<时间戳>.json`。该专项不能替代完整 40 人验收；原始草稿版本已变化时会拒绝继续，不自动覆盖已有文档。

### 2026-09-27 最终验收证据

本轮内网 42 用户实际持续 7202.978 秒，主报告为 **failed**：归档延迟及后台批注质量未达标。外部作品提交、展示读取及此前集中投屏短测的超标另列，不用总体低失败率替代各功能门槛。详见 本机最终报告 `docs/audits/2026-09-26-classroom-capacity/report.md`（过程证据不纳入 Git）。

后台单段批注遇到明确 5xx 时，验收工具仅在数据库 FAILED 终态、完整模型原文与失败审计已核对后，允许相同 requestId/正文进行一次有界重试；首轮失败率与质量失败仍保留。该工具恢复逻辑不等于产品自动重试已掩盖失败。

包含最终数据的本机恢复支持只读逐学生校验；使用 [恢复操作单](../../docs/audits/2026-09-26-classroom-capacity/final-backup-restore-runbook.md)。清理默认仅预览；投屏短测必须显式指定 `--kind=projection-contention` 及完整 `--abort-run=capacity-UUID`，见[精确清理规则](../../docs/audits/2026-09-26-classroom-capacity/cleanup.md)。先留存报告、核对记录并恢复验证，再清理明确所属的测试样本。
