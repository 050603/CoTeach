# V2 数据库与实验采集适配检查（2026-09-08）

> 本文保留首轮数据库检查的范围与结果。后续已扩展 V2 功能及导出；当前 `events`、`submissions`、`outcomes`、`ai`、`domain` 的完整接口契约见[研究数据导出](research-export.md)。下文“当前适配边界”描述的是首轮检查时的状态。

## 检查范围与事实

检查了 [Prisma 模型](../../prisma/schema.prisma)、完整迁移链、平台账号/课程/活动/模板/课堂入口、学习事件、普通活动提交，以及旧课堂持久化入口。当前模型共 46 个（含本次新增 ActivitySubmission）。

本次只读检查的本地 PostgreSQL 16.9 数据库在变更前已应用 20 次迁移；有 2 个用户、1 个教学班、1 条选课，活动、课堂参与、学习事件、AI 事件均为 0。已检查的跨课程进度/课堂参与、非法邀请码计数、空 owner 系统凭据重复均为 0。这是本地库的一次快照，不能代表其他部署环境。

## 已实现的结构与行为

| 问题 | 调整 | 保证范围 |
| --- | --- | --- |
| 加入课程时选课、活动进度和邀请码计数分别写入 | 整体事务；读额度前锁邀请码，同用户加入时锁账号 | 失败不留半条选课，最后一个名额不被并发超用；重复加入不重复计数 |
| 重置令牌可被并发使用两次 | 事务内按未使用且未过期条件消费，再修改密码 | 一次性消费与会话版本递增原子提交 |
| max+1 分配章节位置、活动位置、模板版本和课堂场次有竞争 | 在父记录行锁事务内计算和创建 | 同一父记录的自动分配串行化 |
| 版本检查与更新分离 | 版本检查、更新及关联课堂实例创建同事务 | 携带旧 version 的并发修改返回冲突 |
| 浏览活动可能把刚提交的 COMPLETED 改回 IN_PROGRESS | 只对 NOT_STARTED 条件更新状态 | 当前进度不会被迟到的访问覆盖 |
| 事件可引用别人的 enrollment 或其他课程的 activity | 服务端逐级解析参与→课堂→活动→章节→课程→选课，并校验当前学生 | 整批校验后入库，任意上下文冲突都拒绝 |
| 全局事件键使不同学生互相去重 | 唯一约束改为 (userId, idempotencyKey) | 同学生重试幂等，不同学生键相同也可记录 |
| 研究身份随运行关系丢失 | LearningEvent 保存 Enrollment.researchKey 快照 | 历史只在选课确属该用户/课程时回填，无法确认的仍为 null |
| 再次交作业会覆盖上次答案 | 新增 ActivitySubmission，每次保存答案、研究键、活动版本与题目配置快照 | 最新进度用于界面，历史用于分析；两者同事务提交 |
| 删除用户/课程可级联删除学习事实 | 学习事件全部上下文外键及提交历史外键使用 Restrict | 有历史的对象应停用/归档，物理删除需专门处理研究留存关系 |
| 事件时长和邀请码计数缺少数据库兜底 | CHECK 非负时长、正事件/活动版本、合法邀请码额度 | 直接 SQL 也不能写入这些非法值 |

新增迁移：[20260908120000_research_integrity](../../prisma/migrations/20260908120000_research_integrity/migration.sql)。学习事件按课程/接收时间/id、研究键/发生时间建立索引；提交历史按活动与选课建立时间索引。未在无真实负载的情况下声称性能提升幅度。

数据库 FK 检查引用是否存在；跨课程一致性由当前 V2 写入服务校验。绕过服务直接改外键、researchKey 或历史 payload 的管理脚本，仍可能破坏研究语义。应用没有历史更新/删除接口，本次没有增加数据库级 UPDATE/DELETE 禁止触发器。

## 数据含义与采集契约

- `Enrollment.researchKey` 是每条选课的假名标识，同一学生在不同教学班有不同标识。它不是跨课程全局实验受试者编号。
- `occurredAt` 是客户端发生时间；`receivedAt` 是数据库接收时间。允许离线上报较早的事件，拒绝超出服务器时间 5 分钟的未来事件；增量导出按接收时间排序。
- `eventVersion=1` 是事件结构版本，不是实验组、干预条件或量表版本。真实实验分组与量表方案确定后再建立明确关联，不从已有答案推断实验分组。
- 事件 POST `/api/platform/events` 每批 1–100 条，单条 metadata JSON 最多 32,768 字符；时长是非负毫秒整数。必须至少给出一个可解析的上下文 ID，服务端补齐其祖先和选课。课堂事件必须关联学生实际参与过的实例。
- `idempotencyKey` 在同一用户范围内唯一；客户端重试必须重用原键，新事件必须使用新键。重复键会返回已接受，不能用旧键修改旧事件。
- 普通活动每次成功提交均是一条提交记录，包括同答案再次提交；不把 HTTP 请求次数等同于独立实验尝试。旧 ActivityProgress 已被覆盖的答案无法恢复，本次不伪造历史。
- `activity_opened` 当前每个活动/选课只记录一次；`classroom_entered` 按参与记录/分钟去重。两者不是完整访问次数、停留时长或眼动/注意力证据。

## 教师研究导出

已登录且与教学班存在 CourseTeacher 关系的教师可访问：

```text
GET /api/platform/offerings/{offeringId}/research-export?type=events&take=200
GET /api/platform/offerings/{offeringId}/research-export?type=submissions&take=200&includeContent=true
```

返回 `exportVersion`、`window`、`rows`、`nextCursor`。保持相同 `type`、`includeContent`，持续携带 `nextCursor` 作为下一页的 `cursor`，直到为 null；不要只保存第一页。`type` 可为 events/submissions，`take` 最大 500；可显式指定 ISO 时间 `since`、`until`。首请求默认固定截止到当前时间，后续游标绑定教学班、数据类型和时间窗口，以 `(时间,id)` 排序，避免同毫秒多条记录漏页。

默认白名单不导出 userId、enrollmentId、姓名、自由文本 metadata、题目及答案；只有显式 `includeContent=true` 才导出内容。默认字段中的 researchKey 仍是可关联的假名标识，不应称为完全匿名数据。自行写入自由文本的身份信息不会自动被清洗；需要答案的研究导出应自行按实际研究要求处理这些文本。

`quality=missing_research_key` 表示旧事件的身份快照无法可靠补齐；分析时应单独处理，不能将其当成已匹配样本。分页固定时间窗口不是数据库跨请求快照：若有事务在首请求时尚未提交、之后才提交且其接收时间落在窗口内，实时导出仍可能漏到；正式实验封存导出应在采集停止、在途事务完成后执行，日常增量采集应重叠窗口并按记录 id 去重。

## 第一轮适配边界（历史记录）

以下为第一轮完成时的状态；后续课堂、AI 与页面适配及新增迁移已更新，见 [V2 功能适配记录](v2-function-adaptation.md)。

| 功能 | 检查结论 |
| --- | --- |
| 账号、选课、教学班、章节、普通活动、模板版本与课堂参与入口 | 使用 V2 模型；本次修复相应事务、归属和历史记录 |
| 作业/测验/表单/资源完成 | 保存最新进度和本次提交快照；历史可分页导出 |
| V2 学习事件 | 当前有活动首次打开和课堂进入调用；支持经校验的客户端批量事件 |
| 旧课堂学习分析与 AI 协作 | 旧 `session-repository.ts` 等仍有 `@ts-nocheck` 和已删除模型调用；部分旧入口明确 410，不能认为已适配 V2 |
| V2 课堂运行 | 当前学生页面的进入操作保存参与记录；这不等于旧课堂播放、AI 对话、成果、评价等完整链路已接入 |
| AiInteractionEvent / DomainEvent 等其余事实表 | 本次未实现新的 V2 AI 写入服务或其导出；AI 事件仍存在用户删除级联风险，接入前需同样补齐身份快照、上下文校验、幂等与留存策略 |
| 旧运维验证脚本 | `test:classroom-flow`、`db:migrate-from-json` 仍面向旧模型，不能用来证明 V2 持久化正确 |

后续课堂实验应先完成上述旧课堂/AI 链路的 V2 适配，并用一次完整课堂实测核对事件、AI 交互、干预、成果和评价能否通过同一个 participation 关联。当前改进为已运行的 V2 课程和普通活动采集提供基础，没有宣称整个旧课堂实验链路已恢复。

## 验证与迁移操作

```bash
node scripts/verify-research-database.mjs
pnpm exec vitest run src/lib/platform
pnpm typecheck
DATABASE_URL=postgresql://validation:validation@127.0.0.1:5432/validation pnpm exec prisma validate
```

隔离验证自动新建并清理独立 Docker PostgreSQL 16.9 容器，完整执行历史迁移，再验证新增迁移、历史回填、幂等、约束、删除限制与事务回滚；不读取现有 DATABASE_URL 或 .env。容器检查使用一次性数据，不能替代生产备份恢复演练或浏览器端到端验收。

其他环境应用前先核对迁移状态并备份：历史 `20260908090000_v2_database_rebuild` 会删除 public 下旧表；仅切换 PostgreSQL schema 无法隔离它。不得把本次增量优化理解为授权重跑历史重建或重置数据库。本次新增迁移不清表，非法存量额度/时长会使事务失败并回滚；应调查真实异常，不能随意修改实验记录以通过约束。

### 本次执行结果

- Prisma schema 校验、全局 `pnpm typecheck`、相关 ESLint、差异空白检查通过。
- 汇总定向测试 10 个文件、66 项通过（平台、研究导出路由、密码、事务重试和注册页面）；新增导出测试的类型错误已修正并单独复测。
- 独立 PostgreSQL 16.9 运行全部迁移和真实约束验证通过；[实际业务持久化脚本](../../scripts/verify-platform-persistence.ts) 还验证了真实 repository 的注册/登录、并发额度与选课去重、一次性重置、章节与模板编号、重复交作业快照、并发访问保留 COMPLETED、学习事件上下文与原子拒绝。脚本仅允许带本次随机标记的隔离数据库。
- 当前本地 V2 数据库已应用本次唯一待执行的增量迁移；应用前创建并检查了 PostgreSQL 自定义格式备份，保存于 `/home/lkj/.local/state/openpbl/backups/before-research-integrity-1788866976217.dump`，文件权限 0600。应用后用户 2、教学班 1、选课 1，数量未变，新历史表及 researchKey 字段可查询。
- 未部署远端应用，未执行浏览器课堂端到端实验；不能将上述数据库验证等同于旧 AI 课堂功能已全面适配。
