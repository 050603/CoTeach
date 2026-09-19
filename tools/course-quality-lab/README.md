# 课程质量对比实验室

这是运行在 `3010` 端口的独立实验工具。它只读写 `.openpbl-runtime/course-quality-lab/`，不会创建正式课程、修改正式数据库或切换正式生成入口。

## 生成链路

V4 和 V5 都使用相同的技术验收与恢复策略。内容质量约束放在教学设计和首次生成提示中，新任务不再调用内容审核、内容修正或修后复审模型。

```mermaid
flowchart LR
  A[冻结课程资料与 TTS 配置] --> B[一次结构化教学设计]
  B --> C1[逐页 PPT]
  B --> C2[逐页讲稿]
  C1 --> D[JSON、DSL、字段与引用校验]
  C2 --> D
  D --> E[生产场景组装]
  E --> F[按实际讲稿生成测验]
  F --> G[PPTX、讲稿与课堂数据导出]
  G --> H[完整 TTS]
  H --> I[文件、音频绑定与播放完整性验收]
```

两页课程正常需要 6 次逻辑模型调用：教学设计 1 次、PPT 2 次、讲稿 2 次、测验 1 次。事实正确性、知识内容是否充分、PPT 与讲稿的语义一致性、文风、重复、时长偏差和布局审美不进入生成后的审核，也不会触发模型修正。

教学设计仍使用冻结资料建立逐页职责、可见要求、讲稿步骤、来源摘录、测验范围和自然语速目标。整节目标时长由输入页数与单页目标冻结，设计模型只分配页间份额，不得为容纳更多段落自行延长。讲解步骤、提问位置和段落结构由知识难度、学习对象和前后逻辑决定，不设置逐页固定数量；设计只要求相邻步骤职责清楚、同一案例或结论不重复完整讲解，并让中心机制和易错点获得更多篇幅。首次讲稿使用适合学习对象的课堂口语，保留证据状态与适用边界，同时检查示例中的时长、篇幅和任务条件是否相容。PPT 与讲稿按页并行生成；测验只依据最终实际讲稿，减少首次生成中的目标漂移。

共性的自适应讲稿原则与正式生成共用，按学习目标、已有基础和理解障碍选择讲法；相邻段落可以共同完成推理，不要求每段独立重复完整教学循环。策略全文参与检查点指纹。设计依据、实现边界及本次实验见 [自适应讲稿设计](../../docs/quality/adaptive-narration-design.md)。

## 技术校验与重试

每个模型阶段只允许两次真实请求，网络/API异常与无效输出共享同一预算：

- 瞬时网络错误、429、500、502、503、504、连接中断和超时可重试一次。
- JSON、DSL、必填字段、稳定 ID 或动作引用无效时，第二次请求会收到上一轮的具体技术错误。
- 401、403、配置错误和明确不可重试错误直接失败。
- 流式模型请求使用 300 秒无活动超时和 600 秒绝对上限。
- 排队但尚未开始的请求不计入预算；已经开始但进程中断的请求计入预算。
- TTS 每个片段最多调用两次，只补失败片段，并复用指纹一致的成功音频。
- 本地导出遇到瞬时错误时重试一次。

原始模型响应在解析前落盘。进程恢复时先重新解析已有响应，并复用已完成的设计、PPT、讲稿、测验和音频。3010 页面上的“重试失败阶段”会启动一个新的恢复轮次，给未完成阶段新的两次请求机会，不重跑成功检查点。

`calls.json` 区分首次请求、传输重试、无效输出重试和断点恢复；`model-responses/` 保存原始响应；`partial.json` 保存逐页技术检查点；`telemetry.json` 保存恢复与耗时；`tts-calls.json` 保存音频调用和缓存结果。技术策略、提示版本和超时都进入生成指纹与实验冻结协议。

## 完整交付条件

课程必须同时满足以下条件才能标记“技术校验通过”：

- 每个教学页均有合法 PPT DSL、完整讲稿动作，并能组装为生产播放场景。
- 节末题结构有效且能组装为测验场景。
- PPTX、讲稿、课堂播放 JSON 和音频包存在、非空且可读取。
- 每个非空讲稿片段均有成功音频、有效时长和正确的 speech action 绑定。
- PPT、讲稿和 TTS 三类产物状态全部完成。

任何必要产物缺失都会成为技术失败，不以部分课程冒充成功。真实时长偏差、文本风格和布局密度只进入提示，不改变完整产物的成功状态。历史实验的旧质量审核字段继续兼容展示，新结果只写 `technicalValidation`。

## 生成、恢复与清理

生成或恢复单组：

```bash
pnpm quality-lab:generate -- --section generative-ai-verification --batch 1
```

只补缺失或失败的真实音频：

```bash
pnpm quality-lab:generate -- --section generative-ai-verification --batch 1 --tts-only --retry-failed
```

为已经耗尽自动预算的失败阶段开启新恢复轮次：

```bash
pnpm quality-lab:generate -- --section generative-ai-verification --batch 1 --retry-technical
```

清理无产物且没有人工评判的失败或占位记录：

```bash
pnpm quality-lab:cleanup
```

生成与清理使用同一互斥锁。成功产物、人工评判和共享资源会保留；清理移出的独占文件暂存在运行目录的 `.trash/`。

## V4 / V5 固定对比实验

实验 runner 固定模型、推理配置、TTS、fixture、代码工作区指纹和技术生成策略。中断后的 `--resume` 只恢复失败和未开始的 arm，已完成 arm 不会重跑。

```bash
pnpm quality-lab:experiment -- \
  --experiment-id modular-pipeline-v5-candidate-1 \
  --model deepseek:deepseek-v4.1-flash \
  --reasoning none \
  --tts-provider qwen-tts \
  --tts-model qwen-audio-3.0-tts-flash \
  --tts-voice longanfengyue \
  --resume
```

实验记录保存在 `experiments/<experiment-id>/experiment.json`，产物保存在 `runs/<experiment-id>/<section>/1/<variant>/`，报告写入 `reports/<experiment-id>.md`。报告中的通过状态只表示技术产物完整；时长保留为观测指标。

## 启动与验证

```bash
pnpm quality-lab:build
systemctl --user restart openpbl-course-quality-lab.service
curl http://127.0.0.1:3010/api/health/live
```

打开 <http://127.0.0.1:3010>。人工对比评判仍自动保存到 `reviews.json`，页面支持导出 JSON、CSV、PPTX、讲稿和音频包。

```bash
pnpm quality-lab:typecheck
pnpm quality-lab:test
pnpm exec eslint tools/course-quality-lab --max-warnings 0
```
