# CoTeach V2 数据库设计

## 总览

V2 使用 **PostgreSQL 16 + Prisma 6**。当前正式业务/基础设施表共 **45 张**，数据库连接由 `DATABASE_URL` 配置；不是 MySQL，也不再使用旧的 `Course`、`Teacher`、`StudentAccount` 等兼容模型。

本次重构是全新数据库模型。迁移 `20260908090000_v2_database_rebuild` 会删除旧表并按 V2 建表；旧数据、旧 ID 和旧 API 不做迁移。旧 API 由 Proxy 返回 `410 V2_ROUTE_REQUIRED`。

## 数据表清单

### 用户与认证（2）

| 表 | 存储内容 |
| --- | --- |
| `User` | 统一的学生/教师身份、账号、密码哈希、角色、状态、会话版本、最后登录时间。 |
| `PasswordResetToken` | 密码重置令牌哈希、过期时间、使用时间及所属用户。 |

### 长期课程平台（7）

| 表 | 存储内容 |
| --- | --- |
| `CourseOffering` | 某教师某学期开设的真实教学班、时间、封面、状态、设置和乐观锁版本。 |
| `CourseTeacher` | 用户与教学班的授课关系及角色，支持主讲、助教和联合授课。 |
| `CourseInvitation` | 独立课程邀请码、状态、有效期、使用上限、使用次数和停用时间。 |
| `Enrollment` | 学生用户与教学班的唯一关系、状态、加入/退出/完成时间和匿名研究键。 |
| `Chapter` | 教学班章节、顺序、开放时间、开放状态和归档信息。 |
| `Activity` | 章节活动；类型为课堂、作业、测验、表单或资源，附活动配置 JSON。 |
| `ActivityProgress` | 某个选课学生对某个活动的当前进度、开始/完成/最近访问时间及进度 JSON。 |

### 课堂库与课堂运行（7）

| 表 | 存储内容 |
| --- | --- |
| `ClassroomTemplate` | 教师课堂内容库中的可复用课堂及其状态。 |
| `ClassroomTemplateVersion` | 课堂模板不可变版本、版本号、发布状态、课堂快照和媒体引用。 |
| `ClassroomInstance` | 某教学班某 Activity 的真实课堂运行、模板版本、运行次数、状态和起止时间。 |
| `ClassroomParticipation` | 某次课堂实例中某个选课学生的参与记录、进入时间、完成时间和阶段进度。 |
| `StudentProjectWorkspace` | 一次课堂参与对应的学生项目工作区状态和 AI 成员 JSON。 |
| `GenerationJob` | 通用课堂/课程生成任务、请求、结果、进度、重试、心跳和质量报告。 |
| `GenerationCheckpoint` | 生成任务按步骤保存的可恢复状态快照。 |

### 学习成果与评价（6）

| 表 | 存储内容 |
| --- | --- |
| `ClassroomSubmission` | 学生在一次课堂参与中的阶段提交、提交状态和业务 payload。 |
| `Artifact` | 学生项目成果实体，如报告、PPT、代码、网页、图片或压缩包。 |
| `ArtifactVersion` | 成果版本、HTML/文件引用、MIME、哈希、大小、状态和提交时间。 |
| `ShowcasePresentation` | 成果展示申请、审核/排期/展示状态及展示内容。 |
| `Reflection` | 学生反思内容、关联活动、作者和分析元数据。 |
| `Evaluation` | 教师、学生、同伴、AI、展示或小组贡献等统一评价记录、分数、量规和结果。 |

### 协作与课程内容（10）

| 表 | 存储内容 |
| --- | --- |
| `ProjectGroup` | 教学班项目小组及状态。 |
| `GroupMember` | 小组成员关系、课堂参与关联、成员角色和加入/退出时间。 |
| `WorkPlanItem` | 小组工作计划、负责人、关联活动、截止时间和完成状态。 |
| `GroupBoard` | 小组白板的单一 JSON 快照和版本。 |
| `Announcement` | 教学班、课堂或小组公告及其作用域。 |
| `AnnouncementReply` | 公告回复、作者和创建时间。 |
| `Todo` | 教学班/小组/活动待办事项、创建者、截止时间和状态。 |
| `TodoCompletion` | 用户完成待办的唯一记录和完成时间。 |
| `Resource` | 课程资源业务信息、类型、元数据及活动关联。 |
| `FileAsset` | 统一物理文件元数据：存储键、原名、MIME、大小、哈希、上传者和删除时间。 |

### AI 与教学支持（8）

| 表 | 存储内容 |
| --- | --- |
| `AiConversation` | 学生与 AI 的对话线程及课程/课堂上下文。 |
| `AiMessage` | 对话中的单条用户或 AI 消息、角色、正文和元数据。 |
| `AiTask` | AI 后台任务生命周期、输入、输出、错误和时间状态。 |
| `AiActionConfirmation` | 需要用户确认的 AI 操作、载荷、决策者和决策状态。 |
| `AiSupportRecord` | AI 诊断、教学支持和动态支架（`type = DYNAMIC_SCAFFOLD`）记录。 |
| `LearningSignal` | 学习困难、风险、异常状态及 AI 检测信号。 |
| `Intervention` | 教师在线/线下干预、对象、渠道、内容和发生时间。 |
| `TeacherAgentDirective` | 教师对 AI 后续教学行为策略的指令、状态和有效期。 |

### 数据与事件（3）

| 表 | 存储内容 |
| --- | --- |
| `LearningEvent` | 学生学习事实事件；保存必要的用户、教学班、选课、活动、课堂和参与上下文，追加写入。 |
| `AiInteractionEvent` | 学生与 AI 的请求、响应、建议、采纳、拒绝、撤销、策略和错误事件，追加写入。 |
| `DomainEvent` | 教师和系统业务审计事件，例如活动更新、课堂开始、阶段切换和资源创建，追加写入。 |

### 基础设施（2）

| 表 | 存储内容 |
| --- | --- |
| `ProviderCredential` | AI Provider 配置、凭据、状态、归属和轮换时间。 |
| `LoadTestRun` | 压测任务的配置、结果、状态和执行时间。 |

## 关系主链与约束

系统主链是：

```text
User → Enrollment → CourseOffering → Chapter → Activity → ActivityProgress
                                      ↓
                     ClassroomTemplate → Version → ClassroomInstance
                                                   ↓
                         ClassroomParticipation → 成果 / AI / 评价 / 事件
```

关键唯一约束包括：`User.usernameKey`、`CourseInvitation.code`、`Enrollment(userId, offeringId)`、`Chapter(offeringId, position)`、`Activity(chapterId, position)`、`ClassroomTemplateVersion(templateId, version)`、`ClassroomParticipation(instanceId, enrollmentId)`、`ActivityProgress(enrollmentId, activityId)`。

`LearningEvent`、`AiInteractionEvent`、`DomainEvent`、`AiMessage`、`ArtifactVersion` 和 `GenerationCheckpoint` 按追加写入设计；业务实体使用 `status`、`archivedAt` 保存历史稳定性，复杂且属于实体内部的数据才使用 JSONB。
