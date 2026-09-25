# 学生端、教师端上线前检查记录（2026-09-25）

本记录对应 `4615a98` 加本轮修复，在 Linux 6.8 x86-64、Node.js 24.19.0、`corepack pnpm` 10.4.1 上完成。原始日志、批量截图和 trace 已按后续清理要求从仓库移除；以下数字保留为当轮检查记录，不表示清理后又重新执行了一次。复跑产物默认进入被 Git 忽略的 `test-results/prelaunch/`，也可通过 `PRELAUNCH_OUTPUT_DIR` 指定仓库外目录。需要复核具体场景时应重跑相应脚本，不能把已删除的证据当作仍可查阅的附件。

当轮覆盖清单为 **66 项通过、0 项失败、7 项阻塞、3 项不适用**，逐项范围、前置条件、预期和对应检查名称见 [coverage.md](coverage.md)。生产构建三引擎页面矩阵为 **1692/1692**，其中 Chromium 149.0.7827.55、Firefox 151.0、WebKit 26.5 各 564 项；包括 768 像素分屏、1024×576 至 3840×2160、DPR 1/2、长标题、长链接及课堂面板。隔离生产实例中的真实业务检查为 **73/73**，浏览器交互检查为 **78/78**，应用单元与组件测试为 **3517 通过、7 跳过**；类型检查、受影响文件 Lint、DSL 239 项、导入器 33 项和渲染器类型检查通过。上述统计是清理前实际执行的结果。

真实业务检查使用一次性 PostgreSQL、独立 Redis、上传目录和生产构建，通过正式注册、登录取得教师和学生会话；业务写入、刷新及数据库持久化由 [功能检查脚本](../../../scripts/verify-prelaunch-functional.mjs)断言。页面适配的模拟接口只用于布局、边界和故障注入，不计为真实业务持久化。AI 文本、语音合成与识别、图片生成、向量服务各有一次最小成功调用；未配置的 PDF 解析服务、视频生成和网页搜索保留为阻塞。本轮未做压测、并发或长期稳定性测试。

本轮修复了 4K 顶部返回入口与讲授字幕栏尺寸、窄屏课堂目录遮挡、学生会话水合与实时状态竞争、PDF 投屏重进后的页码恢复、WebKit 侧栏点击、视频自动播放拒绝后的提示和重试，以及生产构建 CSS 字节损坏。生成 CSS 的检查已接入 `pnpm build`。构建通过后已重启 `openpbl.service`；当轮本机 3000/3002 健康检查、正式域名 HTTPS/重定向/深层链接与静态资源检查通过。清理操作未改动当前生产构建或服务。

复跑入口为 `corepack pnpm verify:prelaunch`，顺序执行三引擎页面矩阵和隔离业务检查；加 `--with-providers` 执行已配置外部服务的最小调用。浏览器、视口、场景、地址及输出目录分别由 `PRELAUNCH_BROWSERS`、`PRELAUNCH_LAYOUT_DEVICES`、`PRELAUNCH_TEACHING_DEVICES`、`PRELAUNCH_LAYOUT_SCENARIOS`、`PRELAUNCH_TEACHING_SCENARIOS`、`PRELAUNCH_BASE_URL`、`PRELAUNCH_OUTPUT_DIR` 控制。实现见[统一入口](../../../scripts/run-prelaunch-audit.mjs)、[平台布局检查](../../../scripts/check-desktop-layout.mjs)和[授课布局检查](../../../scripts/check-teaching-layout.mjs)；浏览器交互测试在 [`e2e/`](../../../e2e/) 中。默认单 worker 顺序执行，WebKit 容器需设置 `PRELAUNCH_WEBKIT_CONTAINER=1`。

**上线结论仍为暂缓签署全面通过。** 尚缺完整 PBL 课程生成及正式发布到学生端、OpenMAIC 页面流式对话及断流恢复的真实浏览器闭环；Windows/macOS 原生浏览器、系统与浏览器缩放、中文输入法组合输入须按[实机补验单](native-acceptance.md)执行。当前运行 Node.js 24.19.0，目标 Node.js 22 尚未实测。Linux 上的三引擎与 DPR 模拟不能证明所有电脑均可正常使用。
