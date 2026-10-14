# CoTeach 数据库设计

系统使用 PostgreSQL 16、pgvector 与 Prisma 6，连接由 `DATABASE_URL` 配置。当前 [Prisma schema](../prisma/schema.prisma) 定义 **71 个业务与基础设施模型**，不含 Prisma 的迁移记录表；实际部署库以已应用的[迁移链](../prisma/migrations)为准。

数据库承载教学班、可复用备课、课堂运行、学生学习记录、教材证据与实验测量。应用中的 `Course` 等类型是读取视图，持久化以本文列出的实体为准。

## 关系主链

```text
CourseOffering → Chapter → Activity
    ↑                         ├─ ActivityProgress / ActivitySubmission ← Enrollment ← User
CourseTeacher ← User          └─ ClassroomInstance ← ClassroomTemplateVersion ← ClassroomTemplate
                                   ├─ ClassroomParticipation ← Enrollment
                                   │    └─ 工作区 / 阶段提交 / 成果 / 反思 / 评价 / AI / 事件
                                   ├─ ExperimentAssessmentAssignment ← Enrollment
                                   │    ├─ ExperimentAssessmentDraft
                                   │    └─ ExperimentAssessmentSubmission
                                   └─ PublicDiscussionSession → PublicDiscussionTurn

ClassroomTemplate → CourseTextbookBinding → TextbookRevision → 章节 / 原文 / 概念 / 案例 / 图片
        └─ CourseEvidenceSnapshot → CourseEvidenceSnapshotBinding
TextbookRetrievalItem → TextbookEmbedding ← EmbeddingProfile
```

`ClassroomInstance` 通过 `Activity → Chapter` 归属教学班，使用指定模板版本；同一课堂活动再次授课产生新的 `runNo`。学生通过教学班选课进入场次，以 `ClassroomParticipation` 关联课堂学习证据。实验前后测以选课与场次关联，前测可以早于首次进入课堂。

## 数据表清单

### 用户与认证（2）

| 表 | 存储内容 |
| --- | --- |
| `User` | 统一账号、学生/教师角色、密码哈希、状态、会话版本和最后登录时间。 |
| `PasswordResetToken` | 令牌哈希、用户、有效期和一次性使用状态。 |

### 教学班与活动（8）

| 表 | 存储内容 |
| --- | --- |
| `CourseOffering` | 教学班、学期、起止时间、状态、设置、归档时间和版本。 |
| `CourseTeacher` | 用户与教学班的授课关系及角色。 |
| `CourseInvitation` | 课程邀请码、有效期、使用上限、计数和停用状态。 |
| `Enrollment` | 学生与教学班的唯一选课关系、状态和假名研究键 `researchKey`。 |
| `Chapter` | 教学班章节、顺序、开放时间、归档状态和版本。 |
| `Activity` | 章节中的课堂、作业、测验、问卷或资源活动及其配置。 |
| `ActivityProgress` | 每条选课对某活动的最新进度、访问与完成时间、最新答案投影。 |
| `ActivitySubmission` | 普通活动的历次提交、提交时活动版本与题目配置快照、答案和研究键。 |

### 课堂内容、运行与生成（7）

| 表 | 存储内容 |
| --- | --- |
| `ClassroomTemplate` | 教师课堂内容库中的可复用备课及状态。 |
| `ClassroomTemplateVersion` | 模板版本号、发布状态、设计快照和媒体引用；已发布设计受写入服务保护。 |
| `ClassroomInstance` | 活动的一次授课场次、绑定模板版本、运行配置和起止时间。 |
| `ClassroomParticipation` | 一条选课在某场次的参与、进入/完成时间和阶段进度。 |
| `StudentProjectWorkspace` | 某次课堂参与的项目状态、AI 成员及版本。 |
| `GenerationJob` | 备课、页面、教材等生成任务的请求、结果、质量诊断、进度、重试与心跳。 |
| `GenerationCheckpoint` | 任务按步骤保存的恢复状态；同一 `jobId + step` 的检查点可更新。 |

### 实验前后测（3）

| 表 | 存储内容 |
| --- | --- |
| `ExperimentAssessmentAssignment` | 某场次某条选课的测量分配、A/B 次序及固定的前后测题目。 |
| `ExperimentAssessmentSubmission` | 每个测量阶段的一次正式提交、题目和答案快照、客观分数及研究键。 |
| `ExperimentAssessmentDraft` | 已分配测量的答案草稿、页码、开始时间及乐观锁版本。 |

### 全班公开讨论（2）

| 表 | 存储内容 |
| --- | --- |
| `PublicDiscussionSession` | 课堂知识点讨论、教师与当前发言学生、讨论状态/版本、推荐证据、语音播放租约和总结。 |
| `PublicDiscussionTurn` | 讨论中的有序发言、角色、正文、输入来源及去重请求键。 |

公开讨论与学生私聊分开存储；课堂成员可查看公开对话，学生推荐证据仅通过教师范围的响应返回。

### 教材库、证据与检索（18）

| 表 | 存储内容 |
| --- | --- |
| `Textbook` | 教材目录、维护者、当前修订和归档状态。 |
| `TextbookRevision` | 修订号、源文件、内容哈希、解析/提取版本、处理状态和错误。 |
| `TextbookSection` | 修订内的章节树、标题路径、层级和顺序。 |
| `TextbookSourceBlock` | 章节原文块、类型、顺序、原始与规范化文本。 |
| `TextbookConcept` | 概念、别名、解释、章节和来源类别。 |
| `TextbookConceptEvidence` | 概念与原文块的引用区间。 |
| `TextbookConceptRelation` | 概念间的真实关系、来源和证据。 |
| `TextbookExample` | 教材案例、正文与原文关联。 |
| `TextbookConceptExample` | 概念与案例的多对多关系。 |
| `TextbookFigure` | 教材图片、源块、文件、图注、尺寸和可用状态。 |
| `TextbookConceptFigure` | 概念与图片的多对多关系。 |
| `TextbookRetrievalItem` | 原文、概念、案例的检索项、内容指纹与全文检索字段。 |
| `EmbeddingProfile` | 向量供应商、模型、凭据引用、1024 维配置和处理版本指纹。 |
| `TextbookEmbedding` | 检索项在特定配置和内容指纹下的向量、处理状态、重试与错误。 |
| `CourseTextbookBinding` | 模板与教材修订的绑定及主教材标记。 |
| `CourseTextbookSection` | 绑定实际采用的教材章节范围。 |
| `CourseEvidenceSnapshot` | 模板采用的证据快照、版本、状态、当前标记及指纹。 |
| `CourseEvidenceSnapshotBinding` | 证据快照对应的教材绑定。 |

`TextbookRetrievalItem.searchVector` 为 PostgreSQL 生成的全文检索列，`TextbookEmbedding.embedding` 使用 `vector(1024)`。扩展、部分唯一索引与额外约束由迁移 SQL 管理，不能只根据 Prisma 字段推断全部数据库约束。教材使用和生成证据的规则见[课程生成契约](course-generation.md)。

### 学习成果与评价（6）

| 表 | 存储内容 |
| --- | --- |
| `ClassroomSubmission` | 每次参与每个阶段的当前提交、状态和内容。 |
| `Artifact` | 某次参与的报告、课件、代码、网页等成果实体，可关联小组。 |
| `ArtifactVersion` | 成果版本、HTML/文件引用、MIME、哈希、大小和提交状态。 |
| `ShowcasePresentation` | 展示申请、审核、排期和展示内容。 |
| `Reflection` | 反思正文、活动/参与关联和分析元数据。 |
| `Evaluation` | 教师、同伴、AI 等评价的对象、评分、量规和结果。 |

### 协作与课程内容（10）

| 表 | 存储内容 |
| --- | --- |
| `ProjectGroup` | 教学班项目小组及状态。 |
| `GroupMember` | 小组成员、课堂参与关联、角色和加入/退出时间。 |
| `WorkPlanItem` | 工作计划、负责人、活动、截止时间与完成状态。 |
| `GroupBoard` | 小组白板 JSON 快照与版本。 |
| `Announcement` | 教学班、课堂或小组公告。 |
| `AnnouncementReply` | 公告回复、作者与时间。 |
| `Todo` | 教学班/小组/活动待办、创建者、截止时间与状态。 |
| `TodoCompletion` | 用户完成待办的唯一记录。 |
| `Resource` | 课程资源、类型、活动和文件关联。 |
| `FileAsset` | 存储键、文件名、MIME、大小、哈希、上传者、源文件关系与备份/再生策略。 |

### AI 与教学支持（8）

| 表 | 存储内容 |
| --- | --- |
| `AiConversation` | 用户的 AI 对话及教学班/课堂参与上下文。 |
| `AiMessage` | 对话中的用户、助手或系统消息及元数据。 |
| `AiTask` | AI 后台任务的输入、输出、状态、错误与时间。 |
| `AiActionConfirmation` | AI 操作确认、请求者、决策者和决策状态。 |
| `AiSupportRecord` | AI 诊断、教学支持和动态支架记录。 |
| `LearningSignal` | 学习困难、风险或异常信号。 |
| `Intervention` | 教师干预的对象、渠道、内容与实际发生时间。 |
| `TeacherAgentDirective` | 教师给 AI 的教学策略指令、状态和有效期。 |

### 学习与业务事实（3）

| 表 | 存储内容 |
| --- | --- |
| `LearningEvent` | 学生学习事实、上下文、研究键快照、客户端发生时间与服务器接收时间。 |
| `AiInteractionEvent` | AI 请求、响应、建议、采纳/拒绝等事实、角色与研究键快照。 |
| `DomainEvent` | 教师、学生与系统的业务操作事实、上下文及研究键快照。 |

### 配置、运维与共享讲解（4）

| 表 | 存储内容 |
| --- | --- |
| `ProviderCredential` | 模型服务配置、加密凭据、状态、归属和轮换时间。 |
| `LoadTestRun` | 压测配置、结果、状态和执行时间。 |
| `KnowledgeExplanation` | 按题目、答案、教材证据和模型配置缓存的共享知识讲解，以及任务租约、错误与重试时间。 |
| `KnowledgeExplanationWarmup` | 随发布保存的讲解预热任务，包含输入、状态、次数、租约和重试时间。 |

共享讲解的键和提示词不包含学生身份或个人对话历史；学生后续私聊仍使用独立对话记录。

## 版本、事务与留存

关键唯一约束覆盖用户名、邀请码、选课、章节/活动顺序、模板版本、场次编号、课堂参与、活动进度、实验分配与阶段提交。发布后的模板设计、活动提交历史、实验正式提交和成果版本通过对应写入服务保留快照；当前进度、阶段提交、测量草稿、生成检查点与任务状态可更新，不能将其当成完整操作历史。

`LearningEvent`、`AiInteractionEvent`、`DomainEvent` 以追加事实使用，并通过 `Restrict` 外键保护关联记录。事实留存不意味着所有业务表均禁止删除，也不构成数据库级 UPDATE/DELETE 禁令。跨教学班、选课、参与和小组的语义一致性仍需经过应用写入服务。完整约束与数据含义见[研究留存合同](database/research-integrity.md)，导出见[研究数据导出](database/research-export.md)。

文件元数据与实际文件字节需要一起恢复。`FileAsset` 区分必须保留的源文件和可通过源文件、再生配方重建的衍生产物；备份操作遵循[部署与恢复说明](../deploy/README.md)，不能以数据库备份代替文件备份。

## 迁移与验证

常规检查和已确认环境的增量部署使用仓库封装命令：

```bash
pnpm db:status
pnpm db:migrate:prod
```

执行前核对目标数据库、待执行迁移和可恢复备份。部署要求 pgvector；仓库 [PostgreSQL 镜像](../deploy/postgres/Dockerfile)固定 PostgreSQL 16 与 pgvector 0.8.6。未经扩展准备的普通 PostgreSQL 镜像不能完成教材库迁移。

历史迁移 `20260908090000_v2_database_rebuild` 会删除 `public` 下除 `_prisma_migrations` 外的所有表及数据。它不是日常升级或数据恢复命令；在有数据的环境不得把完整迁移链重放视为常规操作，切换 URL 的 schema 也不能隔离这段 SQL。保留迁移文件以支持新库构建和隔离验证，生产迁移与恢复按部署说明执行。

数据库验证入口与浏览器复跑要求见[研究留存合同的验证章节](database/research-integrity.md#验证入口)。本文描述当前源码合同，不提供某次测试或部署已通过的结论。
