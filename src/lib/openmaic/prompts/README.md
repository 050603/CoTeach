# 应用提示词

此目录保存 CoTeach 课堂运行时、教学工具和应用专用生成模板。加载器从仓库根目录下的 `src/lib/openmaic/prompts` 读取；生成包还拥有自己的 Markdown 资产，见 [@openmaic/generation](../../../../packages/@openmaic/generation/README.md)。修改前先追踪调用方使用哪个加载器。

## 所有权与入口

| 范围 | 维护位置 |
| --- | --- |
| 文件模板、复用片段、课堂角色与导演提示 | 本目录的 `templates`、`snippets`、`index.ts`、`loader.ts` |
| 生成包的基础提示与局部组件合同 | `packages/@openmaic/generation` |
| 小节页面与连续主稿、资料来源、恢复身份 | `src/lib/course-design`、`src/lib/course-generation` |
| 当前原生课件、讲稿动作和检测适配 | `src/lib/openmaic/generation` |
| 通用语言、证据与受众规则 | [prompt-quality/policy.ts](../../prompt-quality/policy.ts) |

当前教师入口按小节直接依据原文联合创作页面计划与连续讲稿。普通课件走原生页面适配，视觉动作绑定已有主稿；本目录存在 `requirements-to-outlines` 或 `slide-content` 同名模板，不表示修改该文件会改变所有当前课程生成请求。完整职责见 [课程生成](../../../../docs/course-generation.md) 与 [OpenMAIC 适配](../../../../docs/openmaic-upstream.md)。

## 目录与语法

```text
src/lib/openmaic/prompts/
├── loader.ts
├── index.ts
├── types.ts
├── templates/<prompt-id>/system.md
├── templates/<prompt-id>/user.md
└── snippets/<snippet-id>.md
```

`system.md` 必需，`user.md` 可选。模板处理顺序为片段包含、条件块、变量插值：

| 语法 | 行为 |
| --- | --- |
| `{{variableName}}` | 使用 `buildPrompt(id, variables)` 的值；对象序列化为 JSON |
| `{{snippet:snippet-name}}` | 读取片段文件并插入；片段缺失时抛错 |
| `{{#if conditionName}}...{{/if}}` | 使用同一变量记录的真值决定是否包含；不支持嵌套 |

新增变量使用 camelCase，模板与片段 ID 使用 kebab-case。已有部分基础模板使用 snake_case；修改兼容调用时保留它们与调用方的对应关系。

未知变量占位符会原样保留；`loadPrompt` 加载失败返回 `null`。调用方必须处理加载失败，并验证完整提示没有遗留 `{{…}}`，不能把错误占位符送入模型。加载器逐次读取磁盘，不缓存模板；生产部署仍遵守仓库构建与运行目录隔离，不能将改文件即时可读等同于生产版本已同步。

## 语言、教学与证据规则

中文课程及业务的可见文字使用自然、准确的简体中文。必要专名、代码、公式、JSON 键和规定枚举可保留英文，课程明确指定其他语言时沿用该语言。内部字段、证据 ID、阶段代码、状态、审查记录和模板占位符只能进入规定结构，不能被复述进标题、讲稿、字幕、学生反馈或人物名称。

空值、未填写学情和没有过程记录只表示未知。结论依据实际提供的课程、教材和学生证据；推断与事实、通行知识与原文引述分别表达。学习难度、术语、例子和任务量按学段调整；AI 不替学生完成核心成果，也不替教师作最终判断。

页面和讲稿分别读取实际采用原文。页面准确提炼主要认识，讲稿保持完整事实、关键定义、必要条件、原因与案例边界，不能从 PPT 短句反向创造定义。替换、删除、比较或影响范围只是辅助判断线索，不能被升级为充分条件或标准答案；资料没写出依据也不代表依据不存在。教材中不同作者、版本、清单和案例事实保持各自身份。

学情与页面职责决定讲解深度和支架，不按知识点、段落、互动、例子或动作数量机械填充。连续讲稿使用明确指代、自然语流与准确术语；熟悉背景可简讲，关键机制详讲，相邻段落共同完成解释，不每页重做固定开场与总结。共用规则见 [adaptive-narration-policy](snippets/adaptive-narration-policy.md) 和 [teaching-accuracy-policy](snippets/teaching-accuracy-policy.md)。

JSON 请求须声明明确 schema 与职责，只返回要求结构。首次作答内静默检查事实、术语、内部一致性、学段和字段完整性；不把自检文字输出给用户，也不据一条自检要求宣称质量已经通过。生成后质量诊断及技术失败按 [课程生成合同](../../../../docs/course-generation.md) 分别处理。

## 添加或修改模板

1. 在 `templates/<id>` 创建模板，或在 `snippets` 创建实际复用片段。
2. 在 `types.ts` 声明 `PromptId` / `SnippetId`，模板 ID 同步到 `index.ts` 的 `PROMPT_IDS`。
3. 让实际调用方使用 `buildPrompt`，传齐变量并处理 `null`；按受众接入统一规则，避免同名模板形成未调用副本。
4. 更新受影响的提示词、生成或编译政策与检查点身份，运行相关回归。

部分角色条件与回复长度仍由 [prompt-builder.ts](../orchestration/prompt-builder.ts) 组合；小节创作、原生画面和模型调用适配也包含 TypeScript 提示。维护时核对实际拼装结果，不只检查 Markdown 文件。

## 验证

应用相关提示词回归位于本目录，统一规则回归位于 `src/lib/prompt-quality`。可从仓库根目录运行：

```bash
pnpm exec vitest run src/lib/openmaic/prompts src/lib/prompt-quality
```

生成包模板变化另运行包测试；恢复政策变化运行对应设计、讲稿、页面和检查点回归。真实 API 验收须使用测试明确的开关，并分别报告模型内容、媒体和播放器范围；只读重放与文档检查不代表执行了真实模型验证。
