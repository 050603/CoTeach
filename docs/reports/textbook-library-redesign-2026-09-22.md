# 教材库与知识图谱改版验收（2026-09-22）

## 实现范围

教材列表、详情阅读和教材图谱采用独立浅色设计。保留原路由、上传及解析接口，不迁移数据库，不改备课/课堂图谱或知识抽取。工作区原有课程生成改动保持原样。

- 教材封面网格/紧凑列表，书名及作者搜索、状态筛选、排序和归档菜单。
- 完整章节树、章节正文、插图、子节、上一节/下一节；知识详情、关联知识与教材证据定位。
- 章节/概念/原文统一搜索，键盘选择、失败重试；URL 与浏览器前进后退同步，按用户和教材版本恢复本机阅读位置。
- 按需加载 AntV G6 5 二维 Canvas：整书章节聚合、章节探索、知识邻域和真实先修方向；筛选、图例、缩放、全屏、键盘替代列表。每次最多 200 个概念，剩余部分可继续翻页。
- 独立章节树与图索引、循环安全遍历、关系方向归一化、视图缓存和过期渲染取消。搜索 API 直接读取版本信息，避免加载全书详情。

## 自动化检查

- 相关 Vitest：64 项通过（10 个测试文件），覆盖章节层级、同名章节和概念、原文定位、浏览恢复、失败恢复、方向、聚合、循环、孤立知识点与聚焦范围外导航。
- 定向 ESLint：通过。
- 全量 `pnpm typecheck`：通过；最终生产构建再次进行 TypeScript 检查。
- `git diff --check`：通过。
- 一次最终构建遇到共享工作区临时测试文件 `interactive-real-acceptance.test.ts` 在类型检查期间消失，触发文件不存在错误；这是构建期间文件变化，未修改或补造该文件，保留运行中的上一构建后重新执行构建。

## 本机同步

最终 `pnpm build` 成功（含 TypeScript 检查），已执行 `systemctl --user restart openpbl.service`。`http://127.0.0.1:3000/api/health/live` 返回 HTTP 200、`status: alive`。浏览器测试访问该生产服务，未以开发端口替代。

## 浏览器和视觉检查

最终 Playwright：**21/21 通过**（52.7 秒），含全屏详情、键盘搜索、浏览器返回/刷新、移动抽屉、解析/检索失败恢复、超 200 节点分页、15 档阅读视口，以及 320px 教材网格/列表。

采用本机 Chromium 和实际 G6 Canvas；规模测试使用隔离 API fixture，不向生产教材库写入数据。另使用实际教材进行只读验收：32 个章节、27 个知识点、248 个原文块、3 张插图、35 条关系。详情 HTTP 200，证据跳转高亮正常，无浏览器 pageerror，手机目录可打开且无横向溢出。最终服务另直接点击真实 Canvas：章节聚合节点可进入 27 节点章节，知识节点点击后 URL 和详情正确更新；初始缩放上限生效，最终图谱截图已覆盖更新。

阅读视觉覆盖 320×568、430×932、568×320、932×430、768×1024、820×1180、1024×576、1024×768、1180×820、1280×720、1366×768、1440×900、1920×1080、2560×1440、3840×2160。验收中发现并修复窄屏导航横向溢出、原文跳转滚动、截图平滑滚动干扰与聚焦范围外关联定位问题。

## 规模与性能

测量从浏览器点击到图谱完成 render、fit 和定位，包含 Playwright 交互/轮询开销与首次引擎加载。数据已就绪；每规模单轮测量，并非多机或 p95 基准。最终构建实测如下：

| 知识点 | 关系 | 概览可交互 | 章节切换 | 当前展开 |
| --- | --- | --- | --- | --- |
| 300 | 1,200 | 975 ms | 300 ms | 25 |
| 1,000 | 4,000 | 999 ms | 602 ms | 84 |
| 3,000 | 12,000 | 1,026 ms | 1,128 ms | 200 |

三档概览均达到 2 秒目标。3,000 节点的局部切换略超过 1 秒目标，尚未达标；不把测试中 15 秒的防挂起阈值当作性能目标通过。此前同规模测量为 1,084 ms，仍有波动及进一步优化空间。[原始计时](../../artifacts/textbook-redesign/acceptance/performance.json)。

## 依赖审计限制

已执行 `pnpm audit:prod`：未通过，现有依赖共 10 项告警（2 critical、3 high、5 moderate）。涉及 Next.js、sharp、js-yaml、baseline-browser-mapping、hono 和 @platejs/core；本次未升级这些依赖。锁文件的依赖变更为新增 G6 及其依赖，审计未报告新增 G6 路径的问题。不能将本次功能验收解释为全项目安全审计通过；框架及相关依赖升级需要单独处理。

## 截图

- [真实教材阅读与知识详情](../../artifacts/textbook-redesign/live/desktop-concept.png)
- [真实教材章节概览](../../artifacts/textbook-redesign/live/desktop-overview.png)
- [真实教材手机目录](../../artifacts/textbook-redesign/live/mobile-directory.png)
- [真实教材只读检查数据](../../artifacts/textbook-redesign/live/validation.json)

- [教材库封面网格](../../artifacts/textbook-redesign/acceptance/library-grid-desktop.png)
- [3,000 知识点的章节聚合概览](../../artifacts/textbook-redesign/acceptance/graph-3000-overview.png)
- [图谱全屏与知识证据](../../artifacts/textbook-redesign/acceptance/graph-fullscreen-with-evidence.png)
- [低高度阅读窗口](../../artifacts/textbook-redesign/acceptance/reader-1024x576.png)
- [平板阅读](../../artifacts/textbook-redesign/acceptance/reader-768x1024.png)
- [320px 手机教材库](../../artifacts/textbook-redesign/acceptance/library-grid-320x568.png)

- [真实教材最终章节图谱](../../artifacts/textbook-redesign/live/desktop-full-chapter-graph.png)
- [真实 Canvas 点击与详情](../../artifacts/textbook-redesign/live/desktop-canvas-selected.png)
