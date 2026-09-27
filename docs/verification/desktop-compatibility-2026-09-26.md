# 2026-09-26 学生端与教师端桌面兼容性验收

状态：**已收尾；适配修复完成，生产构建及服务同步成功。**

本轮以学生和教师的完整界面与功能为重点，优先验收用户实际使用的 Edge 与 Chrome，检查不同电脑分辨率、浏览器缩放下的布局和操作，同时排查组件未实际渲染的问题。已完成下述修复及定向测试；生产页面的已执行结论及未覆盖边界分别记录如下；本轮不代表上线安全审计通过。

## 范围与边界

- 浏览器覆盖以真实 Google Chrome、Microsoft Edge 为重点，并保留 Linux 主机上的 Playwright Chromium、Firefox、WebKit 三引擎交叉检查；模拟不同桌面窗口尺寸与设备像素比，并补充 Chrome/Edge 与 Chromium 原生浏览器缩放。真实品牌浏览器也运行于 Linux，不冒充 Windows/macOS 真机。WebKit 检查不能代替 macOS Safari 真机验收；Chromium 检查不能代替 Windows Chrome/Edge 真机验收。本轮没有 Windows/macOS 真机全量结论。
- 布局脚本覆盖首页、师生登录注册、课程列表与详情、教师设置、学生管理与档案、课程编辑弹窗、教材入口、问卷填写与结果展示，以及知识讲授、AI 协作、幻灯片与编辑器。检查实际布局、内容和操作，不只判断 HTTP 200 或页面标题出现。
- 缩放分开记录：`native-browser-zoom.spec.ts` 通过 Chromium 扩展调用 `chrome.tabs.setZoom`，当前验收覆盖 80%、100%、125%、150%，验证物理窗口尺寸保持不变、实际 zoom 与 DPR、CSS zoom 为 1；另外三引擎缩放布局脚本按物理窗口/倍率计算可用 CSS 视口。这些等效布局测试不冒充 Firefox/WebKit 原生浏览器缩放。用户明确将最高验收倍率设为 150%；此前已完成的 175%/200% 探索记录仅作为补充保留，不再新增极端倍率检查。
- 关键功能回归执行登录必填验证、显示/隐藏密码、登录失败后重试、课程搜索与导航、问卷限选与提交失败后保留答案/重试/修改，以及教师课程设置失败后保留输入、取消与保存；真实点击，不使用 force 绕过遮挡。
- 浏览器验收的大部分业务 API 使用隔离 fixtures，页面与静态运行时来自实际服务。它们不证明真实业务数据链路、并发负载、第三方 AI/语音供应商或公网网络质量已经通过验收。
- 无 HTTPS 的校园内网访问需要 UUID、复制等能力回退；麦克风仍受浏览器安全上下文与用户授权限制。不能将 HTTPS 要求解释为某个操作系统客户端不兼容。

## 修复与行为证据

| 项目 | 原有风险与本轮处理 | 回归断言 |
| --- | --- | --- |
| 紧凑窗口弹窗 | 窄屏课程/表单弹窗标题列只有 32px，但图标宽 42px，吃掉全部间距。标题列改为匹配图标的 42px。 | 先前真实 Edge 探索截图发现，最终改用较小桌面窗口与 150% 验收；布局脚本新增可见图标与标题正文间距至少 8px 的断言；保留修复前截图与更新后复验。 |
| 问卷词云 | 字体请求一直未完成时画布空白。等待字体期间显示完整、可点击且可滚动的词条，字体就绪后切回词云。 | 模拟字体请求挂起，全部关键词仍可选择；字体完成后切回 SVG；原有密集词条回退与窗口尺寸变化用例继续通过。 |
| 反思词云 | 排版器会静默丢弃放不下的长词；强制最小 240px 会裁切窄面板。排版不完整时展示全部词条，布局使用真实宽度，并统一测量与渲染字重。 | 排版结果为 0 或部分词条时仍能选择全部词条；180px 面板不再生成 240px 画布；键盘操作与稳定布局输入继续通过。 |
| ECharts | 应用与 renderer 包在数据变为空时保留旧图。两个实现均主动清除图表，后续有效数据可重新绘制。 | 生命周期测试覆盖有效数据→空数据→有效数据及销毁；既有真实 SVG 测试覆盖 bar、column、line、pie、ring、area、radar、scatter 八类图表，无 NaN/Infinity，并检查紧凑画布的标签与绘图区。 |
| 教师 Recharts 学情图 | 固定 680px 最小宽度使只有两个小节的图表在高倍缩放下产生多余横向滚动。改为按小节数计算宽度、最低 280px；多小节仍保留局部滚动。截图复核另发现 SVG 两端说明文字硬裁切，端点标签改为朝图内对齐，单小节保持居中；完整名称仍在 title 与无障碍摘要中。补充已评分 fixture 及真实图形断言。 | 单元回归不 mock Recharts：从隐藏容器恢复，在 280/680/1280/860/320px 下均生成两条 SVG 趋势线，路径有效，60/80 分摘要正确，卸载清理观察器。浏览器脚本另检查可见 SVG 与两条实际路径。 |
| UUID | 非安全上下文可能没有 `crypto.randomUUID`，影响课堂操作。统一使用已有 UUID 工具，以 `crypto.getRandomValues` 生成 RFC 4122 v4 回退。 | 安全上下文使用原生方法；HTTP 缺少 `randomUUID` 时仍生成格式正确、互不相同的 UUID。 |
| Monaco | 中文资源或编辑器运行时失败可能一直显示加载中。共享加载状态并等待真正初始化；失败或 20 秒超时显示错误与重新加载入口。 | 并发调用共享加载；中文脚本先于编辑器初始化；语言包失败可重试；编辑器失败和两种挂起情形均终止等待。实际失败后的用户恢复入口为重新加载页面。 |
| 录音 | 固定 WebM 容器不适用于仅支持其他录音容器的浏览器。根据 `MediaRecorder.isTypeSupported` 选择格式，保留真实 MIME 与文件扩展名；缺少麦克风能力时提供文字回答路径。 | WebM、MP4/M4A、Ogg 容器与上传文件名匹配；没有首选容器时使用浏览器默认值。此项单元验证不代表真实麦克风硬件或语音供应商已实测。 |
| 正式 HTTPS 入口 | nginx 用旧静态 CSP 覆盖应用策略，遗漏 WASM 执行许可；本机 3000 正常不能证明正式入口正常。HTTP/HTTPS 模板改为透传应用策略，HTTPS 独立保留 upgrade-insecure-requests。 | 对实际容器备份、重新生成配置，`nginx -t` 后 reload；真实 HTTPS 健康检查通过，新增两项配置回归；最终 Chrome/Edge/WebKit 已经过真实 TLS/代理入口执行 PDF、Python 和 Three，9/9 通过；未绕过 CSP 或证书验证。 |
| 沙箱 Python | WebKit 会把 srcdoc 沙箱的 fetch 视为不透明来源，只有 `connect-src self` 时会拦截同源 Python WASM/标准库。响应 CSP 增加当前请求经校验的 HTTP(S) origin，保持 iframe 沙箱和外部网络限制。 | 验证不同部署域名、反向代理协议、IPv4/IPv6，并拒绝可注入额外 CSP 指令的 Host；新版实际 WebKit Python 在本机 HTTP 与正式 HTTPS 均已通过，真实执行并返回 42；Chrome/Edge HTTPS 同样通过。 |
| 浏览器存储 | 隐私策略可能使主题偏好读写抛异常并影响课堂加载。偏好存储失败时保留内存状态。 | `localStorage.getItem` 抛 SecurityError 时组件仍显示；写入抛 QuotaExceededError 时切换主题及根节点样式仍生效。 |
| 剪贴板 | HTTP 环境缺少 Clipboard API，或写入被拒绝时，复制失败可能被误报成功。增加浏览器选区复制回退与明确失败结果。 | 覆盖原生复制、API 缺失、写入被拒绝后的回退、回退失败及临时元素清理；调用方依据结果显示反馈。 |
| PDF 阅读器 | 现代 PDF.js 构建依赖部分目标浏览器尚不具备的 API。同步并使用匹配版本的 legacy 主模块及 worker。 | 两处阅读器路径均为 `/vendor/pdfjs/pdf.legacy.min.mjs` 与 `/vendor/pdfjs/pdf.worker.legacy.min.mjs`；同步来源为同一 pdfjs-dist 版本，避免主模块与 worker 版本错配。最终 Chrome/Edge/WebKit 正式 HTTPS 实际绘制 PDF、读取文字与像素通过；另外覆盖真实 worker 缺少新 API 的情况。 |
| PPT importer 内嵌 PDF 图片 | EMF 内嵌 PDF 转图片依赖 CDN worker，可能受 CSP 或校园网络限制而退化为透明图片。新增可配置 worker，部署后的浏览器入口配置同源 legacy worker；通用包与 Node 默认行为保留。 | 在临时目录实际执行同步脚本，导入生成入口，验证业务导出、同源 worker URL/文件及原包默认值；模拟嵌入 PDF 转换，验证所配置 worker 被使用并产出 PNG、释放文档。该转换用例使用模拟 PDF/Canvas，不等于真实 EMF 样本视觉验收。 |
| Three.js | 生成的互动页面引用外部 CDN，与生产 CSP 冲突。固定 `three@0.160.0` 并通过同源运行时路由提供模块与 addons，重写对应 import map/导入地址。 | 检查 CDN 地址改写；读取实际 Three.js、OrbitControls、SVGRenderer、Projector 资源，验证 JavaScript MIME、跨源沙箱加载头与缓存；拒绝不支持的版本、非浏览器文件和路径穿越。最终 Chrome/Edge/WebKit 正式 HTTPS 在沙箱内加载本地模块与 addons、生成真实 SVG 均通过；不依赖外部 CDN。 |

相关源码入口：

- 词云：[survey-word-cloud.tsx](../../src/components/platform/survey-word-cloud.tsx)、[reflection-word-cloud.tsx](../../src/components/views/teacher/reflection-word-cloud.tsx)。
- 图表：[应用 Chart](../../src/components/openmaic/slide-renderer/components/element/ChartElement/Chart.tsx)、[renderer Chart](../../packages/@openmaic/renderer/src/elements/chart/Chart.tsx)、[教师学情图回归](../../src/components/views/teacher/knowledge-lecture-analytics.test.tsx)。
- 浏览器能力：[UUID](../../src/lib/browser/random-uuid.ts)、[Monaco](../../src/lib/browser/code-editor-runtime.ts)、[录音](../../src/lib/browser/audio-recording.ts)、[复制](../../src/lib/browser/copy-text.ts)、[主题](../../src/lib/openmaic/hooks/use-theme.tsx)。
- PDF/importer：[同步脚本](../../scripts/sync-maic-importer.mjs)、[媒体转换](../../packages/@openmaic/importer/src/utils/mediaWebConvert.ts)、[同步入口行为回归](../../packages/@openmaic/importer/test/browserAssets.test.ts)。
- Three.js：[运行时路由](../../src/app/api/openmaic/interactive-runtime/%5Bruntime%5D/%5B...path%5D/route.ts)、[iframe 地址改写](../../src/lib/openmaic/utils/iframe.ts)。

## 已执行测试记录

以下按本轮执行批次记录通过数量；不同批次可能包含同一用例，**不直接相加作为去重后的测试总数**。

| 批次 | 已报告通过 | 范围 |
| --- | ---: | --- |
| 课堂资源与作品展示 | 35 | `simple-stage-resources.test.tsx`、`teacher-presentation-analytics.test.tsx`、`showcase-selection-panel.test.tsx`。 |
| 图表与词云 | 30 | 两类词云、真实 Recharts、八类 ECharts SVG、紧凑图表与两套组件生命周期。 |
| renderer 包 | 12 | 包内现有三个测试文件。 |
| 客户端能力 | 47 | UUID、编辑器、录音、复制及相关调用方兼容性批次。 |
| importer 同源 worker | 2 | 浏览器部署入口与嵌入 PDF 转换配置。 |
| 师生界面功能（前期浏览器回归） | 75 | 真实 Chrome 154.0.8037.57、Edge 154.0.4258.37 及 Chromium/Firefox/WebKit 各 15 项，覆盖 1366×768、150%/200% 等效可用视口下的 5 条操作流程；全部通过，无跳过和失败后重试。 |
| Chrome/Edge 原生缩放（前期探索） | 96 个检查点 | 两个真实稳定版浏览器 × 两种物理窗口 × 六档倍率 × 师生登录/教师设置/学生问卷四种交互；全部通过，24 个用例零失败、跳过或重试。使用独立浏览器 profile 的原生默认缩放设置，验证真实 DPR、CSS 视口与原生窗口，没有 CSS zoom 或视口模拟。 |
| Chromium 原生缩放（前期探索） | 48 个检查点 | 两种物理窗口 × 教师课程/学生课程/教材阅读/教师登录 × 80%/100%/125%/150%/175%/200%；全部通过。截图采用 CDP 原生捕获，避免 Playwright fullPage 在 viewport:null 时裁切；品牌原生缩放另记。 |
| nginx CSP 配置 | 2 | 代理透传应用策略，HTTPS 保留独立升级策略。 |
| CSP 与部署来源处理 | 22 | CSP、请求来源、Proxy 公开入口与 Next 配置回归；生产脚本保持沙箱、拒绝不合法来源和策略注入。 |
| Three.js 与互动运行时 | 18 | iframe 重写及运行时资产路由批次。 |

图表专项对应测试：

```sh
pnpm exec vitest run \
  src/components/platform/survey-word-cloud.test.tsx \
  src/components/views/teacher/reflection-word-cloud.test.tsx \
  src/components/views/teacher/knowledge-lecture-analytics.test.tsx \
  src/components/openmaic/slide-renderer/components/element/ChartElement/Chart.test.ts \
  src/components/openmaic/slide-renderer/components/element/ChartElement/Chart.lifecycle.test.tsx
pnpm --dir packages/@openmaic/renderer exec vitest run
pnpm --dir packages/@openmaic/importer exec vitest run \
  test/browserAssets.test.ts test/mediaWebConvert.pdfWorker.test.ts
```

图表/importer 相关 ESLint、renderer 与 importer 类型检查、差异检查已通过。根应用 TypeScript、生产构建、25 份 CSS 完整性和生产包数据隔离检查已通过。构建存在 file-type 动态依赖警告，构建状态为成功。没有把源码测试通过视为浏览器已运行新产物。

## 生产浏览器与服务验收

完整浏览器复验对应的发布包 `OCPAIb5-VmhQgMzh-1ybR` 已通过生产构建，于本机时间 10:45 重启服务。通过实际进程工作目录核对 live BUILD_ID，与预先准备的不可变发布包一致；健康接口返回 200。没有仅依据健康接口判断新版本生效。浏览器定向复验结果见下表；最后标签对齐修改的发布状态见文末收尾记录。

| 项目 | 最终状态 |
| --- | --- |
| 工作区包构建与浏览器资源同步 | 通过；安装固定版本 Three.js 时保留完整 postinstall，依次构建工作区包、同步浏览器解析器并生成 Prisma 客户端。 |
| 根生产构建与 CSS 检查 | 通过；`pnpm build`、TypeScript、47 个静态页面、25 份生成 CSS 完整性检查及运行数据/密钥隔离检查全部成功。 |
| `openpbl.service` 重启与 `/api/health/live` | 通过；实际 BUILD_ID 与准备发布包一致，HTTP 响应已含当前请求 origin 的新 CSP。证据：`production-release.json`。 |
| 新版 Chrome/Edge 平台布局 | 96/96 通过；各 16 个页面/状态 × 1024×768、1280×720、1366×768 × 150% 等效布局，弹窗标题间距、溢出、加载与关键操作断言通过。`postdeploy-platform/`。 |
| 新版 Chrome/Edge 功能流程 | 30/30 通过；两品牌各 5 条流程 × 100%/125%/150% 等效视口，零失败/跳过/重试。`flows/postdeploy-{google-chrome,microsoft-edge}.json`。 |
| 新版 Chrome/Edge 原生 150% | 6 个用例、24 个交互检查点全部通过；两品牌 × 1024/1280/1366 物理窗口，确认真实 DPR/UA/可用视口，登录、设置保存/取消、问卷提交后修改均可操作。`flows/postdeploy-native-*.json`。 |
| 新版教学布局与真实图表/课件 | 40/40 通过；5 浏览器各 8 项，100% 分屏/1366 与 150% 的 1024/1366 窗口；真实图表不横滚、课件图片/公式/图形、倍速/静音操作均正常。`teaching/post-fix-summary.json`。后续仅追加端点标签向图内对齐的修正；定向单元与 ESLint 已通过，旧版真实浏览器几何断言可准确复现裁切。用户要求收尾后未再扩大或重复浏览器矩阵。 |
| 新版 Chrome/Edge 本机组件 | 32 个不同场景均有通过证据；Chrome 首次 16/16，Edge 首次 15/16 加测试竞态修正后 Three 1/1。覆盖师生列表网络恢复、学生作品、教师 PDF、新旧教师视图、教材图谱与阅读、Python/PDF/Three。`final-branded-components/README.md`。 |
| 正式 HTTPS 组件 | 9/9 通过；Chrome、Edge、WebKit × PDF/Python/Three；WebKit 本机 Python 另 1/1 通过。`final-https-runtime/`。 |
| 正式 HTTPS 入口页面 | Chrome/Edge × 首页/教师登录/学生登录，6/6 通过；实际 TLS、代理、安全策略、静态资源与布局检查。`final-https-entry/report.json`。 |

浏览器检查入口为 [check-desktop-layout.mjs](../../scripts/check-desktop-layout.mjs)、[check-teaching-layout.mjs](../../scripts/check-teaching-layout.mjs)，批量入口为 [run-prelaunch-audit.mjs](../../scripts/run-prelaunch-audit.mjs)。最终报告与截图归档在 `test-results/compatibility-20260926/`。平台基础矩阵使用 768×576、1280×720、1366×768、1920×1080、3840×2160 五种内容区尺寸；每个浏览器 38 个页面/状态。等效缩放用 1366×768、1920×1080 两个基准窗口，Chromium/Firefox/WebKit 为 125%/150%/175%/200%，真实 Chrome/Edge 另查 200%。以上高于 150% 的检查是需求收敛前已完成的记录；最终复验和脚本默认范围已收敛到 80%–150%。

前期平台基础与等效缩放共 1398 个检查点中有 3 次 Chromium `ERR_NETWORK_CHANGED`，相同场景独立复跑全部通过，原失败记录保留。前期教学 449 个检查点中 11 次失败均指向已修复的学情图固定最小宽度；新版定向回归单独记录，不覆盖旧失败。前期组件出现 12 次教师 PDF fixture cookie 域名配置错误，修正夹具后全部通过；WebKit Python 的实际 CSP 问题已修复并在新版 HTTP/HTTPS 通过。

正式 HTTPS 首页检查曾有一次图片/字体 `ERR_NETWORK_CHANGED`，独立复跑六项全部通过。Three 测试曾在 iframe 已成功渲染时提前读取 Node 端网络事件数量；改为等待同源资源响应事件后定向复验通过，原始记录保留。这些环境/测试时序失败与实际产品问题分别记录。

检查项包括未捕获页面异常、静态资源加载失败、缺失 fixture、横向溢出、面板裁切、关键操作控件、图片自然尺寸，以及实际 Recharts 路径、ECharts SVG、KaTeX 内容等。仅截图存在或页面可打开不能替代这些断言。

为避免并行构建清理 `.next-build` 导致服务重启沿用旧版本，部署脚本新增 `prepare` 模式：成功构建后先保存独立发布包，再重启并核对实际进程的 BUILD_ID。该模式已实际执行成功，部署说明同步更新。

本轮核对并修复的实际 HTTPS 代理使用 `deploy/nginx/openpbl.conf.template`。本机 3000 与 HTTPS 入口均返回 `Permissions-Policy: camera=(), microphone=(self), geolocation=()`，当前入口没有禁麦阻塞；旧 `deploy/nginx.conf` 的历史策略不应被当作当前生效配置。代理的旧 CSP 覆盖问题已单独修复并重载，见上表。麦克风策略核对不包含真实授权与录音设备测试。

## 依赖安全审计：尚未通过

安装 Three.js 前后依赖审计结果均为 **2 critical、3 high、5 moderate**，新增 Three.js 告警为 **0**；没有消除既有告警。`pnpm audit:prod` 返回 1，不能宣称上线安全检查通过。

依赖审计前后对比保存在本机忽略目录 `test-results/compatibility-20260926/dependency-audit/comparison.md`，原始结果为同目录 `before-three.json`、`after-three.json` 和 `after-three.txt`。

- Next.js 的 [Windows-hosted servers 告警](https://github.com/advisories/GHSA-p293-qw3h-jr36)针对 **Windows 服务端部署**，不等于 Windows 客户端浏览器存在该问题。当前 Linux 服务端不符合该条告警的操作系统前提；这不能用于排除其他告警。
- [Next.js AVIF 图像优化告警](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4)、Sharp/libheif 以及 js-yaml、Hono、Plate 等其余告警仍需独立评估、升级并完成安全回归验收。本轮兼容性修复没有完成这些安全升级，不把浏览器功能测试当作安全审计替代品。
- 发布结论必须分别记录功能适配验收与安全审计状态；不得由“新增 Three.js 告警为 0”推导整个系统不存在高危问题。

## 复验方式

主要脚本以 `--assert` 遇到失败时返回非零状态；全部业务读写由本地 fixture 拦截，不操作师生真实数据。浏览器二进制下载到临时独立目录，没有替换系统浏览器。

```sh
# 平台布局；指定真实 Chrome 或 Edge 的独立二进制。
LAYOUT_BROWSER=chromium LAYOUT_BROWSER_LABEL=edge \
LAYOUT_EXECUTABLE_PATH=/path/to/microsoft/msedge/msedge \
LAYOUT_DEVICES=desktop-768x576,desktop-1280x720,desktop-1366x768,desktop-1920x1080,desktop-3840x2160 \
LAYOUT_OUTPUT_DIR=test-results/desktop-recheck node scripts/check-desktop-layout.mjs --assert

# 真实品牌操作流程；通过环境变量选择已启动的验收服务，避免启动开发服务。
OPENPBL_RESOURCE_E2E_BASE_URL=http://127.0.0.1:3000 \
PRELAUNCH_E2E_BROWSER=chromium PRELAUNCH_E2E_BROWSER_LABEL=edge \
PRELAUNCH_E2E_EXECUTABLE_PATH=/path/to/microsoft/msedge/msedge \
pnpm exec playwright test e2e/desktop-user-flows.spec.ts --workers=1 --retries=0

# 三引擎、HiDPI 与等效缩放批量入口；宿主缺 WebKit 依赖时用配套容器。
PRELAUNCH_WEBKIT_CONTAINER=1 node scripts/run-prelaunch-audit.mjs --browser-only --with-zoom
```

真实品牌原生缩放入口为 `e2e/branded-native-zoom.spec.ts`；Chromium 扩展缩放入口为 `e2e/native-browser-zoom.spec.ts`。品牌二进制与标准 Chromium 的区别可参阅 [Playwright 官方浏览器文档](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)。

## 收尾记录

用户要求停止反复验测后，不再扩展或重复测试矩阵。最后仅执行标签对齐修正必需的生产构建、发布包准备、服务重启与健康检查。最后一次默认 4GB Node 堆的构建曾因构建进程内存不足退出；当前可用版本未受影响，收尾构建仅为该进程提高到 8GB，不改变生产服务内存配置。

白板清理逻辑的并行改动曾出现公开类型缺失，原负责任务已修正，未将该问题归因于图表修改；本轮不宣称其他任务的并发压测或全部后端验收通过。

最终同步已成功：`2026-09-26T11:02:41+0800`，生产 BUILD_ID 为 `A9TGYgj8CIPudtc7k12Kt`，与已准备的发布包一致。`openpbl.service` 重启成功，`/api/health/live` 返回 **200 / alive**，实际教师登录响应包含新版 CSP。收尾构建的 TypeScript、47 个静态页面、25 份 CSS 与运行数据隔离检查全部通过。最后标签修正未再重跑浏览器矩阵；本报告保留前一发布包的完整浏览器证据和标签修正的单元验证边界。

最终日志：`test-results/compatibility-20260926/production-build-closeout.log`；实际运行版本与健康证据：`test-results/compatibility-20260926/production-release.json`。
