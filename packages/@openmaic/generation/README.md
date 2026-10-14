# @openmaic/generation

本包提供无供应商依赖的课程生成契约、提示词与编译原语。CoTeach 的后台任务、教师资料、模型配置和当前产品流程位于应用层，见 [课程生成合同](../../../docs/course-generation.md) 与 [来源和适配](../../../docs/openmaic-upstream.md)。

## 调用边界

`AICallFn` 由调用方提供，接收 system/user 提示词并返回模型文本。包不选择提供方、不读取密钥、不保存数据库任务，也不决定应用的重试权限或整课恢复。

`generateSceneOutlinesFromRequirements`、`generateSceneContent`、`generateSceneActions` 和 `buildCompleteScene` 可独立调用。调用方提供稳定的 `sceneId` 可保持重放场景身份。classic 一键生成和专用 PBL planner 是包能力；CoTeach 当前教师入口先生成小节页面与连续讲稿，再调用页面与动作原语，不直接使用整套 classic 流程。

## 原生页面与可测量组件

幻灯片默认支持可编辑原生元素。`componentAuthoring` 可开启局部组件编译，并需要调用方提供 `textMeasure`；`slideAuthoring` 支持原生或明确选择的 flow 合同。文字、表格、公式和关系图的测量依赖调用方的真实播放字体与 DOM，包不会凭空宣称布局可行。

CoTeach 当前页面适配使用 `nativeDesignBaseline` 与 `preserveNativeComposition`，保持整页原生构图及模型给定的文字层级、形状、表格、图表和素材；局部组件不代替整页设计。该合同允许依据原文准确精炼展示信息，讲稿由应用保存的连续主稿承担。另有明确选择的文本引用槽、flow 分组与续页编译能力，保存任务必须沿用对应的原合同。

关系图编译保留顺序、循环、分支及独立流程组的实际节点与连接。容量问题不能通过删节点、删分支或伪造连接处理。编译诊断和技术失败由调用方分别处理，不能把有元素输出当成所有教学或渲染检查已通过。

## 提示词资产

`templates/`、`snippets/`、`prompts-pbl/` 随包分发，加载器相对本包安装位置读取，源码测试和编译产物使用同一份资产。应用另有 `src/lib/openmaic/prompts` 与 TypeScript 教学适配，二者的同名模板不能互相替代。

包内生成模板与本地编译扩展均在本仓库维护。修改时核对实际调用方、提示词或编译政策、检查点指纹和回归；工作区版本号不表示本地扩展已经由上游发布。

## 输出与失败

`generateSceneContent` 对部分无法准备提示词或无法解析的非 PBL 响应返回 `null`。`onFailure` 可在返回前接收 `prompt-unavailable` 或 `invalid-model-output`，后者还可携带详情和容量分类；其他结构或调用错误可能直接抛出。`generateWidgetContent` 支持相应失败回调。调用方必须区分空或不可执行结果、可用首稿的质量诊断和真实基础设施故障。

PBL scenes 使用同一 `AICallFn` 做单次规划。需要 agentic fallback 的明确调用方可注入 `pblLoopFallback`；执行与提供方仍由宿主负责，不是本包自动替 CoTeach 持久任务重跑。

## 本地检查

在仓库根目录运行：

```bash
pnpm --filter @openmaic/generation test
pnpm --filter @openmaic/generation typecheck
pnpm --filter @openmaic/generation build
```

按改动运行相关应用回归。共享类型、编译器或分发资产变更还须遵守 [开发工作流](../../../docs/agent-workflow.md)，验证应用实际消费的工作区构建产物。
