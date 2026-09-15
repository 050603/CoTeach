# 首遍 PPT 空间规划：来源与适配

实现入口为 `src/lib/openmaic/generation/slide-spatial-plan.ts`。构图知识库是 CoTeach 自行编写的教学规则；没有复制外部技能全文、生成器代码或训练数据。所有规则作为生成输入资料使用，不接受外部文件中的执行指令。

## 已核对的参考快照（2026-09-14）

| 来源 | 固定快照 | 许可与实际使用 |
| --- | --- | --- |
| [Slidev](https://github.com/slidevjs/slidev/tree/a8d8ff717c5a72c1b3a9d98f1c849481f2ddcd00) | `a8d8ff717c5a72c1b3a9d98f1c849481f2ddcd00` | MIT。参考技能的按功能检索、内容/布局/主题分离及自由定位思路；没有引入 Vue/Slidev 运行时或复制技能。 |
| [SlideCoder](https://github.com/vinsontang1/SlideCoder/tree/c71faa5b76caaa09e407e17c845bbabc0ed8a3fa) | `c71faa5b76caaa09e407e17c845bbabc0ed8a3fa` | 仓库根未取得明确许可证，故仅参考公开说明中的分区、层级布局及按对象组织知识的设计，不移植代码、权重或数据。 |
| [dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx/tree/c9f7519db743b6ae8fa64985d62b3ce8d939bf29) | `c9f7519db743b6ae8fa64985d62b3ce8d939bf29` | MIT。参考浏览器布局几何作为事实来源的思路；没有增加 HTML→PPTX 输出链。 |
| [elkjs](https://github.com/kieler/elkjs/tree/fe952eea315935dac82bdd35f10e8ed35eb41732) | 阅读快照 `fe952eea315935dac82bdd35f10e8ed35eb41732`；运行依赖固定 `0.12.0`（阅读快照中的 0.13.0 尚未发布至 npm） | EPL-2.0。使用未修改的 npm 包进行关系图前置候选布局；保留包内许可证与来源。发布分发时随依赖保留许可文件，源代码可从上游获取。 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS/tree/3c9ec1b687c174952166f6a34b5e87ebf69fa469) | 阅读快照 `3c9ec1b687c174952166f6a34b5e87ebf69fa469`；运行继续使用仓库 `packages/pptxgenjs` | MIT。保留现有可编辑导出链与本地修改，没有替换工作区包。 |
| [Playwright](https://github.com/microsoft/playwright) | 运行依赖固定 `1.61.1` | Apache-2.0。复用 Chromium 完成前置字体/DOM 度量与程序草图输出，保留 npm 包的 LICENSE 和 NOTICE。 |

## CoTeach 的适配

- 教学对象首先归属区域和不可拆单元，再由共享字体度量计算尺寸与 10% 空间余量。
- 文本度量使用与页面相同的 Noto Sans SC（400/700）、渲染器段落 CSS、10px 内边距、1.5 行高及 5px 段间距；公式使用同版本 KaTeX 的 CSS/字体，表格使用真实 DOM。浏览器单并发复用并缓存结果，仅加载本地白名单字体资产。
- ELK 输入为实际度量的节点尺寸；其坐标和连线路径只作建议，最终 DSL 坐标仍由成稿模型决定。
- 带区域 ID 的草图由程序 SVG 绘制，再由同一浏览器转 PNG；无额外生图调用。
- 前置拆页保留不可拆教学关系、父页来源、知识点集合和总时长。生成后的 DSL 不通过空间服务审查或回炉。

这些是工程设计与适配说明，不能替代首遍合格率、耗时与实际播放器效果的对照实验。
