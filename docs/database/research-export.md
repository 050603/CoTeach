# V2 研究数据导出

接口：`GET /api/platform/offerings/{offeringId}/research-export`。每一页都重新验证教师登录状态及该教学班的 `CourseTeacher` 关系；学生不能调用此接口。

## 数据类型

| `type` | 数据源与范围 | 排序时间 | 默认字段 |
| --- | --- | --- | --- |
| `events`（默认） | `LearningEvent`，包括五阶段学习事件 | `receivedAt` | 研究键、课堂/活动上下文、事件类型与版本、发生/接收时间、来源、时长 |
| `submissions` | `ActivitySubmission`，普通活动提交历史 | `submittedAt` | 研究键、活动 ID/版本、提交时间 |
| `outcomes` | `DomainEvent` 中 `CLASSROOM_` 前缀事件，保留原接口语义 | `createdAt` | 研究键、课堂实例、事件类型、记录时间 |
| `ai` | 该教学班全部 `AiInteractionEvent`，包括旧协作界面的 V2 事件 | `createdAt` | 研究键、课堂实例、事件类型、参与角色、记录时间 |
| `domain` | 该教学班全部 `DomainEvent`，包含五阶段操作、任务确认、成果归档与展示等事实 | `createdAt` | 研究键、课堂实例、事件类型、记录时间 |

所有类型还包含事件/提交记录 `id` 和 `quality`。完整实验提取应根据需要导出 `events`、`submissions`、`ai`、`domain`；`outcomes` 是 `domain` 的子集，不能把两者拼接后当成互不重复的事实。`domain` 同时包含课程管理操作等非学生行为，不能将其总条数等同于学习行为次数。

## 内容与身份边界

默认不查询或返回用户、选课、参与记录、请求、会话等操作身份字段，不返回姓名、AI 对话文本或自由文本 payload。保留的 `researchKey` 是选课假名标识，能关联同一选课下的记录，不是完全匿名数据。`actor` 是 AI 事件的角色类别，例如 `student`、`assistant`、`system`，不是操作者 ID。

显式 `includeContent=true` 时：

- `events` 增加 `metadata`。
- `submissions` 增加题目快照 `activitySnapshot` 和答案 `payload`。
- `ai` 增加对话/事件 `content` 和结构化 `payload`。
- `outcomes`、`domain` 增加结构化 `payload`。

内容中的自由文本和旧界面兼容字段可能含身份信息，服务不会自动脱敏。即使启用内容导出，接口也不会额外增加顶层 `userId`、`actorId` 等字段。

`quality=missing_research_key` 表示没有研究身份快照。部分课程级或教师管理事实本来就不对应某条学生选课；另一些旧记录无法可靠回填。应按事件语义区分，不能伪造身份匹配，也不能把所有此类记录都解释为采集丢失。

## 分页

```text
GET /api/platform/offerings/{offeringId}/research-export?type=ai&take=200
GET /api/platform/offerings/{offeringId}/research-export?type=domain&take=200&includeContent=true
```

响应为 `{ exportVersion, type, window, rows, nextCursor }`。`take` 范围 1–500；可提供 ISO 格式 `since`、`until`。首请求未指定截止时间时，服务器将当时的时间固定为 `window.until`。

下一页继续携带相同 `type`、`includeContent` 和响应的 `nextCursor`；`since`、`until` 可以省略，由游标恢复。新游标绑定教学班、类型、内容开关及时间窗口；切换任一范围应重新开始导出。持续请求直到 `nextCursor=null`，不能只保存第一页。

排序使用“时间 + id”，同一毫秒有多条记录也能连续翻页。AI 和领域事件使用服务器创建时间，不从用户消息时间推断实际学习发生时间。旧 AI 事件可在 `payload.legacy.occurredAt` 保留原生产者时间，仅在包含内容时可见。

固定窗口不是跨 HTTP 请求的数据库快照：仍在提交中的事务可能稍后出现在窗口内。正式封存导出应先停止采集并等待在途事务完成；持续增量采集应重叠时间窗口并按每种类型的记录 `id` 去重。相同逻辑操作可能分别产生学习事件、AI 事件和领域事实，这些记录表达不同层面的证据，不应简单相加为独立实验次数。
