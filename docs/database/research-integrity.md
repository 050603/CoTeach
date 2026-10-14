# 研究数据与留存合同

本文描述当前采集、提交快照、归属校验和留存边界。实体清单见[数据库设计](../database.md)，分页与管理导出见[研究数据导出](research-export.md)。合同以 [Prisma schema](../../prisma/schema.prisma)、迁移 SQL 和实际写入服务共同为准。

## 区分当前状态与历史证据

| 记录 | 含义与使用方式 |
| --- | --- |
| `ActivityProgress` | 某条选课对活动的最新状态和答案投影；重交会更新，不能据此恢复历次尝试 |
| `ActivitySubmission` | 每次普通活动成功提交的活动版本、配置、答案和研究键快照；与最新进度在同一事务写入 |
| `ClassroomParticipation`、`StudentProjectWorkspace`、`ClassroomSubmission` | 课堂参与、项目和各阶段的当前状态；阶段提交不是逐次操作历史 |
| `ArtifactVersion` | 成果的独立版本、文件/HTML 引用和提交状态；已保存版本不被后续提交覆盖 |
| `ExperimentAssessmentAssignment` | 某场次某条选课固定的前后测题目与情境次序，后续题目配置变化不替换已分配内容 |
| `ExperimentAssessmentDraft` | 测量答案草稿及版本；可继续编辑，正式提交时删除对应阶段草稿 |
| `ExperimentAssessmentSubmission` | 每个场次、选课、测量阶段的一次正式题目和答案快照；相同答案重试复用已提交记录，不同答案重交返回冲突 |
| `LearningEvent`、`AiInteractionEvent`、`DomainEvent` | 分别记录学习、AI 交互与业务操作事实；同一操作可在多个事实层记录，不能简单相加为实验尝试次数 |
| `GenerationJob`、`GenerationCheckpoint` | 生成与恢复的运行状态；检查点按任务和步骤更新，不是追加式实验档案 |

[活动提交服务](../../src/lib/platform/submissions.ts)在事务内确认活动版本，题目已变化时拒绝旧版本答案。再次提交相同普通活动答案仍新增历史记录；实验测量使用相反的“一阶段一次正式提交”规则。分析必须区分这两种计数。

发布课堂使用场次绑定的模板版本；设计修改经备课入口形成相应草稿/版本，不能通过授课动作覆盖已发布设计。模板 snapshot 存设计，实例 runtimeConfig 存运行控制，提交 payload 存学生内容，事实 payload 存单次操作。教材修订、实际采用章节和证据快照用于解释生成依据，不能以当前教材内容替代当时采用的证据。

## 身份、归属与时间

`Enrollment.researchKey` 是每条选课的假名标识，同一学生在不同教学班有不同标识。它可关联同一教学班内的记录，不是跨课程受试者编号，也不是完全匿名数据。学习事件、AI 交互、业务事实和正式提交在写入时保存研究键快照；历史回填只在用户/课程归属可确认时进行。

课堂学习证据通过 `ClassroomParticipation → Enrollment` 关联学生，场次通过 `Activity → Chapter` 关联教学班。客户端提供的 ID 只是待验证引用，服务端逐级解析并核对归属；外键存在不等于跨课程语义正确。教师操作依据 `CourseTeacher`，学生小组操作还需核对实际成员与对象范围。

`LearningEvent.occurredAt` 为客户端发生时间，省略时使用服务器当前时间；`receivedAt` 为服务器接收时间。允许离线上报早于接收时间的事件，拒绝超过服务器时间 5 分钟的未来事件。AI 交互与业务事实的 `createdAt` 是服务器记录时间，不自动代表实际学习发生时间。增量导出按各类型规定的服务器时间排序。

`eventVersion` 表示事件结构版本。实验 `variant` 表示前后测情境次序，客观分数由分配题目的评分规则得出；实验分组、量表含义和测量有效性需依据真实研究方案，不能从事件版本、题目次序或已有答案自行推断。

## 事务、版本与幂等

| 场景 | 当前写入保护 |
| --- | --- |
| 邀请入班 | 邀请码行锁及同用户的串行化保护；选课、初始活动进度和使用计数在事务内提交，重复加入不重复扣额度 |
| 密码重置 | 事务内条件消费未使用且未过期令牌，更新密码并递增会话版本 |
| 章节/活动顺序、模板版本和课堂场次 | 在父记录锁的保护下分配编号，数据库唯一约束兜底 |
| 携带版本的编辑 | 事务内校验版本后写入，过期版本返回冲突 |
| 活动访问 | 只将 `NOT_STARTED` 更新为 `IN_PROGRESS`，迟到访问不能将已完成状态倒退 |
| 普通活动提交 | 活动版本确认、提交快照和最新进度同事务，避免题目与答案错配 |
| 学习事件批量上报 | 全批次解析归属后写入，任何上下文冲突都拒绝整批 |
| 实验分配与草稿/提交 | 场次生命周期守护、单学生分配锁及版本检查；A/B 平衡分配使用场次范围锁，正式提交与草稿清理同事务 |
| 成果归档与 AI 操作确认 | 在实际参与、对象归属、确认状态和幂等回执的保护下执行，正式成果使用独立版本 |

学习事件以 `(userId, idempotencyKey)` 唯一；AI 与业务事实表的 `idempotencyKey` 为全表唯一，由各服务构造操作范围。重试需复用原操作键，新事实需新键。学习事件重复键会被确认为已接受，不能用相同键修改旧内容。

## 学习事件上报

学生通过同源认证请求 `POST /api/platform/events`：

```json
{
  "events": [
    {
      "idempotencyKey": "本次事实的稳定重试键",
      "type": "事件类型",
      "activityId": "当前教学班的活动 ID",
      "occurredAt": "2026-10-14T02:00:00.000Z",
      "source": "platform"
    }
  ]
}
```

每批 1–100 条；单条 `metadata` 序列化 JSON 最多 32,768 字符；`durationMs` 为 0–2,147,483,647 的毫秒整数。至少提供一个可解析的教学班、选课、章节、活动、场次或参与 ID，服务端补齐其祖先及选课。课堂事件必须关联当前学生实际存在的参与记录。响应的 `acceptedIds` 是已持久化或已存在的幂等键，不是新生成的事件记录 ID。实现见[学习事件服务](../../src/lib/platform/learning-events.ts)。

内置 `activity_opened` 对每个活动/选课记录一次；`classroom_entered` 按参与记录和分钟去重。这些事件不能直接当成完整访问次数、停留时间、注意力或眼动证据。客户端时长、自报文本与 AI 推断也应按其真实证据类别分析。

## 数据库约束与留存边界

`LearningEvent` 的用户及全部上下文外键、`AiInteractionEvent` 与 `DomainEvent` 的关联外键使用 `Restrict`。`ActivitySubmission`、实验分配/正式提交/草稿及 `ArtifactVersion` 的关键关联也使用删除限制。已有事实的账号、教学班和课堂对象应通过状态、退出或归档处理；物理删除前需专门处理研究留存关系。

数据库另外检查事件非负时长、正结构版本、合法邀请码额度、正活动版本、实验阶段及客观分数范围。额外检查和部分唯一索引定义在迁移 SQL，不能仅依赖 Prisma 模型检查。相关迁移包括[学习事件与提交留存](../../prisma/migrations/20260908120000_research_integrity/migration.sql)、[AI/业务事实与成果版本保护](../../prisma/migrations/20260908150000_v2_classroom_research/migration.sql)及[实验测量](../../prisma/migrations/20260924100000_classroom_experiment_assessments/migration.sql)。

追加事实是应用使用合同；目前没有禁止全部数据库 UPDATE/DELETE 的触发器。公共讨论等实体仍有自己的级联或置空策略，不能因为事件表受保护就声称所有正文都有不可删除保证。绕过写入服务修改 ID、研究键、题目或 payload 的管理脚本仍可能破坏语义；历史已被覆盖的内容不能伪造恢复。

`quality=complete` 只表明导出记录带研究键；没有研究键的教师/课程操作需按事件语义保留。正式数据封存要处理在途事务与文件字节，不依赖分页接口的固定时间窗口充当数据库快照。具体方法见[导出分页合同](research-export.md#参数与分页)和[部署与恢复说明](../../deploy/README.md)。

## 验证入口

按修改范围选择检查；以下列出可执行入口，不记录某次历史通过结果：

```bash
pnpm exec prisma validate
pnpm exec vitest run src/lib/platform/learning-events.test.ts src/lib/platform/submissions.test.ts src/lib/platform/research-export.test.ts src/lib/platform/experiment-service.test.ts
pnpm test:db:research
OPENPBL_VERIFY_BROWSER=1 pnpm test:db:research
```

`prisma validate` 检查 schema，需合法格式的 `DATABASE_URL`，不会执行迁移。隔离数据库入口 [verify-research-database.mjs](../../scripts/verify-research-database.mjs)需要 Docker 与项目依赖，使用带随机标记、绑定回环地址的独立 PostgreSQL 16/pgvector 容器，执行完整迁移及持久化/约束验证，结束时清理自身资源；它自行构造数据库地址，不向现用库执行迁移。

浏览器模式另需 Playwright Chromium，并通过 [verify-v2-pages.mjs](../../scripts/verify-v2-pages.mjs)核对隔离库的地址和随机标记。它使用临时 Next 构建/上传目录、测试身份和独立端口（默认 3199，可设 `OPENPBL_VERIFICATION_PORT=3199`–`3299`），结束时清理；不使用 3000 上的现用服务。只检查设置与备课可增加 `OPENPBL_VERIFICATION_PAGES=authoring`。

浏览器验证进程屏蔽工作区 `.env*`、旧配置和外部 API key，阻止外部网络；固定教案的设置、备课、师生五阶段页面读取/切换/刷新与业务持久化分别验证。明确的 `AI_NOT_CONFIGURED` 作为环境项报告，不是模型调用成功。隔离检查、真实供应商调用、生成质量验收和生产备份恢复是不同的验证范围，交付时分别说明实际执行结果。

已有部署的迁移先核对待执行项并备份。历史破坏性重建 SQL 的风险与 pgvector 前置条件见[数据库迁移说明](../database.md#迁移与验证)；完整迁移链仅用于已明确允许的新库或隔离验证环境，不能据此重置现用数据。
