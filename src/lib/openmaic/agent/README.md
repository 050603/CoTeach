# 课件编辑 Agent

本模块服务于教师课件编辑器的“AI 编辑”面板。Agent 使用固定版本的 pi 运行循环，经项目模型适配器调用教师配置的模型，向客户端发送 SSE 事件。依赖来源与许可见 [VENDOR.md](VENDOR.md)。学生项目文档和代码协作属于 [ai-collaboration](../../ai-collaboration)，使用独立权限与审计。

## 当前工具

工具由 [registry.ts](tools/registry.ts) 注册，`V0_ALLOWLIST` 保留其代码名称，当前实际开放五项能力：

| 工具 | 行为 |
| --- | --- |
| `read_scene_content` | 读取当前场景、内容、大纲和可用运行错误，作为回答与修改依据。 |
| `regenerate_scene` | 按教师指令重新生成幻灯片内容；知识讲授页面保留既有讲稿、音频、板书、问题和来源职责，只重新绑定视觉提示。其他支持的幻灯片保留内容与讲解重生成流程。 |
| `regenerate_scene_actions` | 教师明确要求时改写板书段落以外的讲稿，保留板书及其讲解、图片和其他动作。 |
| `edit_interactive_html` | 用唯一精确片段替换修复互动 HTML，保留未命中部分。 |
| `edit_whiteboard` | 修改指定既有板书段的内部教学步骤，保留其他页面内容和段外动作。 |

模型提供目标场景、自然语言修改要求或局部精确补丁，重生成工具从已提供的场景上下文读取内容。工具结果通过对应应用器核对场景和当前基线；迟到结果、工具类型不匹配和用户已经修改的内容不能被盲目覆盖。恢复快照支持“还原”已应用的重生成。

## 会话与界面

[agent-thread-store.ts](client/agent-thread-store.ts) 使用 Dexie / IndexedDB 保存每个 stage 的多会话历史；localStorage 只保存当前会话指针及一次性旧格式迁移入口。新会话、切换、删除和历史数量限制分别管理。历史记录保存精简消息，不作为服务器课堂研究审计。

面板负责能力提示、文本或语音输入、工具状态、对话历史和还原操作。语音可用性取决于实际配置；没有语音服务不能显示为已完成识别。

## 维护与验证

修改能力时同步工具注册、allowlist、运行提示词、客户端应用器和工具展示。只读工具结果不能触发修改；幻灯片、讲稿、互动 HTML 与板书的应用边界分别验证。

关键入口为 [build-agent.ts](runtime/build-agent.ts)、[客户端运行器](client/use-agent-runtime.ts)、[重生成应用器](client/apply-regenerate.ts)与[板书补丁](../edit/whiteboard-patch.ts)。按[开发工作流](../../../../docs/agent-workflow.md)选择相关 `src` 测试。
