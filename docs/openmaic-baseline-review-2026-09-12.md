# OpenMAIC 最新能力与 openPBL 适配评估

审阅日期：2026-09-12。范围：教师备课编辑、上游新增能力及与现有系统的差异；本次没有移植运行时代码。

## 对比基准与结论

- 上游：[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)，本次固定审阅 main 提交 [ebf665f316372d6ee875bd50dac1e04662d5a519](https://github.com/THU-MAIC/OpenMAIC/commit/ebf665f316372d6ee875bd50dac1e04662d5a519)，提交日期为 2026-09-11。
- 最新 v1 系列发布标签为 [v1.0.1](https://github.com/THU-MAIC/OpenMAIC/releases/tag/v1.0.1)，提交 f50a25644c9c3893503cf0727ccf613c0ce1e748；更新日志日期为 2026-09-06。main 还包含发布后的变化，不能将所有 main 能力都视为 v1.0.1 默认可用功能。
- 本地：当前工作区源码，包含已有未提交修改。已记录的部分包同步基准见 [openmaic-upstream.md](openmaic-upstream.md)，不能给整个应用套一个统一的旧版版本号。
- 结论：上游已有值得复用的元素级 AI 修改、服务器文档写入和新手动画布；我们的主要工作将是适配工具、编辑器及数据保存边界，而非重做整个系统。上游仍不能直接提供完整的教师备课发布流程、图表数据表单和动态白板编排体验。

## 编辑功能实际如何工作

### 1. 以结构化课件为编辑对象

课堂由 Stage、Scene、页面 content 和授课 actions 组成。手动画布和 AI 工具都围绕这些数据操作，而不是对 PPT 截图修改后再识别回页面。

最新上游的核心 AI 路径是：读取场景树或源数据 → 对单个场景提出修改操作 → 校验所有操作与最终结构 → 保存场景 → 发出更新事件，工作台刷新。

直接证据：[dsl-tools.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/server/agent-runtime/dsl-tools.ts#L750)、[course-tools.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/server/agent-runtime/course-tools.ts#L1)。

### 2. AI 已能做局部修改

patch_stage 面向单个场景，提供 JSON Pointer 路径上的 set/remove、字符串 str_replace，以及 add_element/delete_element。可定位页面元素字段，也可定位讲稿或白板所在的 actions 字段；不是只能整页重新生成。

其保障包括：

- 一批操作有任一步失败，或修改后的结构无效，就拒绝整批写入。
- 新增、删除元素通过受控操作保留服务器管理的身份规则。
- 不允许把读取时隐藏媒体大数据所用的占位符写回真实资源。
- 工具写入按顺序执行，减少同一 Agent 并行修改造成的覆盖。
- 讲稿文字变化会清除对应旧音频引用；generate_tts 可补齐缺失语音，或强制重生整页语音。

边界：结构校验不等于学科事实正确，也不等于讲授时长、板书顺序和教学目标自动保持一致。工具内的整批原子修改，也不能直接等同于多教师协同编辑或已发布课堂版本隔离。

语音处理还需精确区分：补丁会清除文字变化后的旧音频引用，但不会因此必然自动完成新语音合成，需要后续调用 generate_tts；该检查也不能泛化成音色、语速等所有变动都会自动使语音失效。图片生成工具目前接受 prompt/aspectRatio/styleHint 等参数，没有参考图或蒙版输入，适合生成替换配图，不等于保留原图其余区域的局部重绘。

本地对照：[现有工具清单](../src/lib/openmaic/agent/tools/registry.ts)只有读场景、整页重生成、整页 actions 重生成、互动 HTML 替换；适合移植上游局部修改机制并补充本地教学约束。

### 3. 手动画布已有明显升级，但要区分新旧实现

上游新增独立的 @openmaic/editor 包，包含拖动、缩放、旋转、框选多选、对齐、富文本、形状标签、表格单元格编辑等能力。

直接证据：[editor 源码](https://github.com/THU-MAIC/OpenMAIC/tree/ebf665f316372d6ee875bd50dac1e04662d5a519/packages/%40openmaic/editor/src)、[表格编辑器](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/packages/%40openmaic/editor/src/react/table/RendererTableEditor.tsx)。

必须注意：新 renderer 编辑画布受 NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED 控制，默认关闭；旧的应用内 TableElement 仍写明不支持单元格编辑。因此应描述为“上游已实现、需要选择启用并验收的新编辑器能力”，而非所有默认页面都已有完整表格编辑。

当前仍缺专用图表数据编辑表单；白板 actions 可通过数据工具修改，但不能据此声称已有完整可视化白板时间线编辑器。参见[功能开关](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/config/feature-flags.ts#L76)。

### 4. 服务器保存解决了我们上一轮识别出的重要缺口

上游 v1 工作台采用服务端文档、持续会话和事件同步。我们已有的旧编辑组件主要通过 IndexedDB 保存，教师预览又走学生播放器，因此不能仅放开编辑按钮就认为学生会获得修改后的资源。

本地证据：[stage-storage.ts](../src/lib/openmaic/utils/stage-storage.ts)、[学生读取入口](../src/components/openmaic-bridge/student-stage-host.tsx)、[课堂读取 API](../src/app/api/openmaic/classroom/route.ts)。

适配时，应该把编辑草稿保存接入我们自己的教师授权、模板版本和课堂资源模型；发布时绑定新资源版本，已开始的课堂继续引用确定的版本。仅有模板 JSON 快照还不够：其中引用的课堂 ID 若仍指向可覆盖文件，底层资源仍可能发生变化。

可借鉴上游 [stage-freshness.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/workbench/stage-freshness.ts) 的页级 revision 和增量读取，但上游仍有部分读取后写回的竞态边界，不能宣称已解决所有并发覆盖。手动撤销历史会在编辑会话结束时清空；Agent checkpoint 是写入事件，也不等于任意历史版本可回滚。

## 值得适配的能力与优先顺序

| 能力 | 上游情况 | 本地情况 | 建议及预期收益 |
| --- | --- | --- | --- |
| 元素级 AI 修改 | read_stage / patch_stage / grep_stage，支持 content 与 actions | 主要是整页或整页讲稿重生 | 第一优先；减少无关内容被改变，让教师精确修改一段话、一张图或一个表格 |
| 对象引用到聊天 | 工作台可引用单个 PPT 元素 | 未找到对应引用选择链路 | 第一优先；先选对象再描述要求，减少 AI 猜测修改目标 |
| 新手动画布及表格单元格编辑 | 独立 editor 包，有实验开关 | 旧编辑基础，未完整接通教师产品入口 | 第一优先；支持教师直接修正 AI 结果，保留原排版做小改 |
| 编辑服务器保存、语音更新 | 服务端文档工具、讲稿变动清音频引用、generate_tts | 生成资源在服务器；旧编辑保存主要在浏览器 | 第一优先；形成教师预览与学生实际资源一致的流程 |
| 持续对话式备课工作台 | 会话、后台执行、取消、恢复、中途补充指令、事件回放 | 有持久化课程生成任务和检查点；没有同等通用备课 Agent 会话 | 第二优先；把“生成一次”扩展为“反复修订”，复用本地任务基础 |
| 会话资料库、按需读与检索 | 文档/音视频提取，材料 read/search，派生资源与复用 | 已支持参考资料上传和多种文本提取；超长资料存在抽样截取路径 | 第二优先；改善长教材、企业案例、操作录像作为生成依据的可用性 |
| 可复用教学技能 | 费曼、螺旋课程、逆向教学设计、事实核查等可加载技能 | 已有 PBL 约束与教学提示词，没有同等用户技能管理工作流 | 第二优先；先做受控教学策略选项，避免任意技能改变固定阶段与评价契约 |
| 讲稿导出 Markdown / Word | 已有独立导出实现 | 当前教师资源页以复制讲稿为主 | 可提前作为小功能适配；便于教研审稿、备案和离线备课 |
| MP4 课程视频导出 | 编译课程、字幕/媒体打包、独立 Chromium + FFmpeg 渲染服务 | 有 PPTX / 课堂 ZIP 导出基础，未找到同等 MP4 流程 | 后续可选；便于微课和课后复习，但视频不能保留学生可操作的互动体验 |
| 学生引用课件对象提问 | 最新 main 可引用 PPT 元素和静态 GenUI DOM 组件，受功能开关与 Pi chat 路径约束 | 未找到同等对象引用机制 | 第二阶段可试点；让“这个图为什么这样”带上具体对象上下文 |
| 媒体分段读取与按需加载 | Range 响应、媒体渐进加载、图表运行时延迟加载等 | 当前课堂媒体路由整文件读取返回；图表有静态导入 | 可独立适配；改善大音视频的跳播与传输，实际收益需测量 |
| PPTX 公式和导入修复 | 最新 main 增加 Equation.3 / MathType OLE 转 LaTeX、非浏览器导入挂起修复等 | importer 已同步至 0.1.2，未找到相同 MTEF 解析实现 | 按教师实际课件样本挑选；理工课程旧公式导入有潜在价值，不宜直接覆盖本地导入修复 |

本表是代码能力比较与工程建议，不是经过课堂实验验证的教学效果结论。

## 其他能力的证据与限制

- **资料检索**：[上游 document](https://github.com/THU-MAIC/OpenMAIC/tree/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/document)、[词法检索实现](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/rag/providers/in-memory-lexical-index.ts)；本地 [generation-references.ts](../src/lib/course-design/generation-references.ts) 已有参考资料处理，不能写成“我们不能上传资料”。上游的词法检索基础也不等于完整、经过验证的语义知识库。
- **持续 Agent 与材料工具**：[runner.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/server/agent-runtime/runner.ts)、[material-tools.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/server/agent-runtime/material-tools.ts)，包括分页读取和受限搜索，适合在多轮备课中继续引用同一批资料。
- **教学技能**：[skills/agent-runtime](https://github.com/THU-MAIC/OpenMAIC/tree/ebf665f316372d6ee875bd50dac1e04662d5a519/skills/agent-runtime)。这是可运行 Agent 使用的教学方法与工具说明，拥有技能文件本身不代表其教学质量已验证。
- **讲稿导出**：[use-export-script.ts](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/export/use-export-script.ts#L1)，由 speech actions 按页收集，序列化为 Markdown 或真正的 DOCX；不是修改 Word 后自动回写课件。
- **视频导出**：[video-export-app](https://github.com/THU-MAIC/OpenMAIC/tree/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/video-export-app)、[render-service](https://github.com/THU-MAIC/OpenMAIC/tree/ebf665f316372d6ee875bd50dac1e04662d5a519/render-service)。需要独立资源配额与部署，属于更大适配任务。
- **学生对象引用**：[本次 main 提交](https://github.com/THU-MAIC/OpenMAIC/commit/ebf665f316372d6ee875bd50dac1e04662d5a519)、[引用策略](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/lib/interactive/element-reference-policy.ts)。静态 DOM 引用排除 canvas、iframe 等对象，不能直接理解为能读取任何三维画布或模拟器当前内部状态。
- **媒体 Range**：[上游路由](https://github.com/THU-MAIC/OpenMAIC/blob/ebf665f316372d6ee875bd50dac1e04662d5a519/app/api/classroom-media/%5BclassroomId%5D/%5B...path%5D/route.ts#L81)，本地应保留现有每次访问授权、私有缓存策略和 WAV 修复，不能复制上游路由覆盖这些行为。
- **导入修复**：[Equation.3 提交](https://github.com/THU-MAIC/OpenMAIC/commit/0b641a9)、[非浏览器导入修复](https://github.com/THU-MAIC/OpenMAIC/commit/d32c3f2)。这些是发布后的 main 变化，应固定提交，使用真实课件样本验证后移植。

## 已有相近能力，不应重复建设

1. **后台生成与恢复**：我们已有 Prisma GenerationJob、页级检查点、取消和重试，以及独立生成 worker。新增持续会话应建立在已有任务管理之上，或明确做适配层，不能把“耐久任务”当作全新需求。
2. **资产管理**：我们已有 FileAsset、源资源关联、可再生成资源信息和清理/恢复工具。值得借鉴的是把课堂图片、音频、编辑生成的新媒体统一纳入该模型，而不是并排引入第二套资产真源。
3. **课程模板和课堂实例**：本地已有发布快照、教师归属、学生参与记录和课堂实例。上游通用文档所有权不能替代这些教学业务约束。
4. **讲稿跳播**：本地已有 playSpeechAt 和白板状态恢复。上游 action-navigation 可借鉴安全跳转判定，但不应描述为我们没有逐段播放。
5. **DSL、导入器、生成质量约束**：已有部分包同步及本地教学扩展。上游 main 的包版本更高不是整套替换的充分理由。

证据：[job-runner.ts](../src/lib/course-generation/job-runner.ts)、[Prisma 模型](../prisma/schema.prisma)、[模板仓储](../src/lib/platform/pbl-template-repository.ts)、[播放器](../src/lib/openmaic/playback/engine.ts)、[教学场景扩展](../src/lib/openmaic/types/stage.ts)。

## 推荐适配方案

第一批围绕一个完整结果：教师在备课阶段打开 AI 课堂，手动或对话修改指定对象，预览并保存，发布后学生获得对应资源版本。

建议复用上游 editor、对象引用与 patch 工具的核心逻辑，保留我们的教师入口、授权、模板/课堂实例、生成预算与自适应学习契约。统一手动和 AI 修改的提交接口；保存时保留 stageKey、knowledgePointIds、targetDurationSec、分支关联等本地字段。

第一批必须同时处理讲稿旧音频失效、新音频持久化、元素引用和白板动作检查、失败恢复、草稿/发布资源隔离，以及手动与 Agent 同时写入的冲突。不要把浏览器撤销栈当成已发布版本管理。

第二批补资料检索、持续会话、教学策略与学生对象引用。讲稿 Word 导出可穿插提前完成；视频导出与完整工作台文件夹/技能管理放在后面，按教师需求决定。

核心验收场景：只改一段话后其他页和元素保持不变；改讲稿后语音与字幕一致；改表格后数据与呈现一致；保存后换浏览器仍可见；发布前学生不受影响；发布后的新课堂使用新版本而历史课堂可回看旧版本；失败或并发冲突时不静默覆盖教师修改。

## 本次验证范围

已读取 GitHub 页面、获取独立上游检出、固定 main SHA、核对 v1 标签、检查相关实现与测试文件，并与当前工作区入口及数据模型对照。未安装或启动上游，未执行上游测试，未进行浏览器交互与真实课件效果测试。没有改动现有运行时代码或重启服务；性能、编辑成功率和教学收益仍需适配后的验收验证。
