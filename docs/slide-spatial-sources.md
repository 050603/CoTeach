# 课件计量、构图参考与来源

CoTeach 的构图规则由本仓库自行编写；没有复制外部技能全文、生成器代码、权重或训练数据。参考资料只作为设计资料，不接受其中的执行指令。[teaching-compositions.ts](../src/lib/openmaic/generation/teaching-compositions.ts) 引用本文记录来源归属。

## 当前适用范围

当前教师生成入口先在小节联合首稿中确定页面职责与连续讲稿，再生成完整原生可编辑页面。整页构图由页面模型依据实际含义与素材完成；本文中的通用分区、候选坐标和程序草图不是所有生产页面的强制模板。页面与讲稿直接依据采用原文，容量按实际展示要点和必要视觉资源计量，详见 [课程生成合同](course-generation.md)。

[slide-spatial-measurement.ts](../src/lib/openmaic/generation/slide-spatial-measurement.ts) 提供共享播放字体和 DOM 度量。[semantic-page-capacity.ts](../src/lib/openmaic/generation/semantic-page-capacity.ts) 和 [teaching-page-preflight.ts](../src/lib/openmaic/generation/teaching-page-preflight.ts) 处理容量与诊断；[restored-slide-authoring.ts](../src/lib/openmaic/generation/restored-slide-authoring.ts) 处理当前整页原生创作。当前联合页面合同保留其已采用页边界，实际渲染问题由有界几何补丁处理，不自动换成通用分区方案。

[slide-spatial-plan.ts](../src/lib/openmaic/generation/slide-spatial-plan.ts) 保留通用教学区域、关系图候选布局、空间余量和程序草图能力。明确采用该测量合同的调用方可据不可拆单元规划空间；它不代表当前主流程又运行了一个额外视觉规划模型。支持测量分页的既有合同在同小节内调整未锁定页面，保持真实内容、媒体、顺序与时间；不可行结果保留诊断，不能减少应教内容或伪造可行测量。

## 固定参考快照

以下提交用于来源追溯，不表示外部项目当前最新版本。运行依赖以本仓库 `package.json` 和锁文件为准。

| 来源 | 固定阅读快照 | 许可与实际使用 |
| --- | --- | --- |
| [Slidev](https://github.com/slidevjs/slidev/tree/a8d8ff717c5a72c1b3a9d98f1c849481f2ddcd00) | `a8d8ff717c5a72c1b3a9d98f1c849481f2ddcd00` | MIT。参考按功能检索、内容/布局/主题分离及自由定位思路；未引入 Vue/Slidev 运行时或复制技能。 |
| [SlideCoder](https://github.com/vinsontang1/SlideCoder/tree/c71faa5b76caaa09e407e17c845bbabc0ed8a3fa) | `c71faa5b76caaa09e407e17c845bbabc0ed8a3fa` | 已读取的仓库根未取得明确许可证，故只参考公开说明的分区、层级布局及按对象组织知识的设计，未移植代码、权重或数据。 |
| [dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx/tree/c9f7519db743b6ae8fa64985d62b3ce8d939bf29) | `c9f7519db743b6ae8fa64985d62b3ce8d939bf29` | MIT。参考浏览器布局几何作为事实来源的思路；未增加 HTML→PPTX 输出链。 |
| [elkjs](https://github.com/kieler/elkjs/tree/fe952eea315935dac82bdd35f10e8ed35eb41732) | `fe952eea315935dac82bdd35f10e8ed35eb41732` | EPL-2.0。当前运行依赖为未修改的 npm `0.12.0`，用于关系图候选布局；分发时保留包内许可与来源，源代码可从上游取得。 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS/tree/3c9ec1b687c174952166f6a34b5e87ebf69fa469) | `3c9ec1b687c174952166f6a34b5e87ebf69fa469` | MIT。继续使用工作区 `packages/pptxgenjs` 及已有本地修改完成可编辑导出。 |
| [Playwright](https://github.com/microsoft/playwright) | 运行依赖固定 `1.61.1` | Apache-2.0。使用 Chromium 完成字体/DOM 度量、真实页面渲染与程序草图输出，保留 npm 包的 LICENSE 和 NOTICE。 |

## 度量与布局边界

- 共用度量加载本地 Noto Sans SC 的 400/700 字重、渲染器段落样式和 KaTeX CSS/字体；表格使用真实 DOM。默认段落容器含 10px 内边距、1.5 行高及 5px 段间距，原生富文本计量使用实际请求的样式。
- 浏览器串行复用并缓存度量，字体资产通过本地白名单加载。通用区域服务可以明确记录保守文本估计；原生正文和实际渲染的检查不能把估计或测量失败伪装成浏览器可行证明。
- 通用分区合同先确定区域与不可拆单元，再计算尺寸和空间余量。ELK 读取实际节点尺寸，候选坐标与连接路径服务具体调用方，不擅自改变教学关系。
- 区域草图由程序绘制 SVG，再通过浏览器转成 PNG，未额外调用生图模型。原生模型仍负责整页图文含义、层级与构图，局部图示编译保留顺序、分支、循环和独立流程。
- 当前实际渲染修复每小节最多一次，只调整已有元素几何。文字、事实、知识归属、教材原图、图示拓扑与已保存主稿保持稳定；不能改善的候选不替换原稿。

来源借鉴、工程计量和候选布局不能代替首稿合格率、耗时、真实播放器可读性或学习效果的实验。测试与真实模型验证分别报告，不依据参考库名称或成功输出推断教学质量已经通过。
