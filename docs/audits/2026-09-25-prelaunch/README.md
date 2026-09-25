# 学生端、教师端上线前验收（2026-09-25）

本记录对应工作区提交 `4615a98` 加本次未提交修复。业务验收在一次性 PostgreSQL、Redis、独立上传目录和独立生产构建中完成；页面矩阵针对本机 3000 端口的生产服务。所有测试数据均为隔离数据，页面布局用例中的接口响应是明确标记的模拟数据。未进行压测、并发或长时间稳定性测试。

本机为 Linux 6.8 x86-64，实际服务使用 Node.js 24.19.0；命令行 `pnpm` 为 9.9.0，`corepack pnpm` 可提供仓库声明的 10.4.1。仓库文档期望 Node.js 22 / pnpm 10.4.1，因此运行时版本一致性单列为上线配置核对项，不能把本轮结果表述为在 Node.js 22 下已运行。

判定仅使用“通过／失败／阻塞／不适用”。“通过”须有实际执行证据；模拟数据的布局通过不代表真实业务保存通过。最终跨浏览器汇总见 [summary.json](evidence/final-production/summary.json)，独立真实业务复验见 [functional/report.json](evidence/final-production-functional/report.json)，原始日志及截图保存在 [evidence](evidence/)；详细覆盖清单见 [coverage.md](coverage.md)。根目录的 `evidence/summary.json` 是发现问题时的探索轮次，不能作为最终结论。

检查入口：`pnpm verify:prelaunch`。浏览器、视口、场景和输出目录可通过 `PRELAUNCH_BROWSERS`、`PRELAUNCH_LAYOUT_DEVICES`、`PRELAUNCH_TEACHING_DEVICES`、`PRELAUNCH_LAYOUT_SCENARIOS`、`PRELAUNCH_TEACHING_SCENARIOS`、`PRELAUNCH_OUTPUT_DIR`、`PRELAUNCH_BASE_URL` 指定。默认单 worker 顺序执行。`--with-providers` 增加已配置外部服务的最小真实调用。WebKit 使用与 Playwright 版本匹配的容器环境运行，设置 `PRELAUNCH_WEBKIT_CONTAINER=1`。

页面矩阵覆盖 768×576 分屏、1024×576、1024×768、1280×720、1366×768、1440×900、1920×1080、2560×1440、3840×2160，并额外覆盖 768×768；DPR 1 全矩阵、DPR 2 代表窗口。三引擎为 Chromium、Firefox、WebKit。脚本记录页面异常、失败的静态资源、意外接口请求、主文档横向溢出、组件裁切和点击范围；保存代表窗口及失败场景的截图、失败 trace，全部逐项指标见各自的 `report.json`。人工抽查了 768 分屏课堂浮层、4K 学生课程菜单及 4K AI 授课画面。

本次修复后的生产构建上，三引擎主矩阵 [1692/1692 项通过](evidence/final-production/summary.json)，共 12 个分组、0 失败，版本分别为 Chromium 149.0.7827.55、Firefox 151.0、WebKit 26.5。每个引擎执行 10 个平台 DPR 1 窗口、4 个授课 DPR 1 窗口、3 个平台 DPR 2 窗口和 3 个授课 DPR 2 窗口；平台每窗口 38 种场景，授课每窗口 10 种场景。长中文标题、英文长词与超长链接作为平台场景在全矩阵中复验，模拟数据的适配结果不等于真实业务保存结果。此前发现问题时的探索矩阵仍保留在 [旧汇总](evidence/final/summary.json)及 [初轮日志](evidence/final/browser-matrix.log)，不能代替本次最终构建的结果。

真实 Windows/macOS 浏览器、系统缩放、浏览器原生 125%/150%/200% 缩放、中文输入法组合输入和物理触控板仍需按 [实机补验单](native-acceptance.md) 验收。DPR 和有效视口模拟不等于这些实测。未完成前不能宣称“所有电脑均通过”。

独立代码运行服务的 3002 端口对 Python/C 最小程序给出了预期输出，匿名调用返回 401，见 [code-runner.json](evidence/code-runner.json)。

修复后的生产构建通过后已重启 `openpbl.service`，3000 健康接口返回 `alive`，3002 代码运行服务保持 active 且健康接口返回 `{"ok":true}`。正式域名 HTTPS 登录页、HTTP→HTTPS、双角色匿名深层链接、6 个当前构建 CSS/JS 资源和本机入口共 [14/14 项通过](evidence/final-production-deployment-check.json)；全部浏览器与业务测试结束后的[服务健康与构建对应关系 8/8 通过](evidence/final-health-after-tests.json)。本次 3000 端口运行的是修复后的构建。

修复后的应用单元与组件测试 [3517 通过、7 跳过](evidence/final-postfix-unit-full.log)，[类型检查](evidence/final-postfix-typecheck.log)、[受影响文件 Lint](evidence/final-postfix-lint.log)及 [生产构建](evidence/final-build-both-scoped.log)通过。曾发现生产构建退出码为 0 但 CSS 内含损坏字符；两个样式入口现明确扫描运行时 UI 源码及所需依赖，最终 [24 个 CSS 文件完整性检查](evidence/final-generated-css-check.log)通过，并已将异常字节检查接入后续 `pnpm build`。构建仍有 `file-type` 动态依赖的 webpack 警告，未阻止产物生成。DSL [239/239](evidence/dsl-test.log)、导入器 [33/33](evidence/importer-test.log) 通过，DSL 类型检查、导入器 Lint、渲染器类型检查均通过。

旧 `e2e/student-join-class.spec.ts` 直接改动当前数据库并调用已退役的 `/api/auth/join`，本次移除该过时测试；用隔离生产实例中的 V2 邀请码注册、真实 cookie、课堂进入、成果保存与刷新链路替代。登录、注册、加入三个旧接口的 410 行为也加入隔离验收。

本轮修复了 4K 下平台顶部返回入口和 AI 讲授字幕栏的尺寸基准、学生会话水合与实时状态读取的竞争、教师成果投屏 PDF 重进后页码回到首页的问题，以及窄屏 AI 课堂页面目录遮挡、WebKit 侧栏点击偶发失效和浏览器拒绝视频自动播放时缺少恢复入口。对应回归证据见 [最终布局矩阵](evidence/final-production/summary.json)、[应用测试](evidence/final-postfix-unit-full.log)、[PDF 页码实测](evidence/pdf-retest-fixed.log)及 [WebKit 视频恢复重复测试](evidence/final-video-webkit-repeat.log)。视频拒绝与恢复截图在 [evidence](evidence/) 中按引擎保存；三引擎各一次通过，WebKit 另连续 3 次通过。

隔离功能预检使用真实注册和邀请、独立教师/学生会话，验证四类普通活动、课堂活动、模板第二版、成果提交与评价。额外生成了三件套 ZIP（知识点 Markdown、教案 Markdown、PPTX），实际上传、解析、转成 PDF 并确认保存；WAV 与 WebM 也经过实际上传、原字节下载和浏览器播放推进。预检记录见 [media-preflight/report.json](evidence/functional/media-preflight/report.json)。最终生产版[交互浏览器组 78/78 通过](evidence/final-production-interactive.log)，其 API 夹具只用于页面行为，不作为数据库持久化证据。

最终独立生产构建的 [真实业务报告](evidence/final-production-functional/report.json)为 73/73 通过；教师、学生账号经正式注册与登录取得 cookie，使用一次性 PostgreSQL、Redis 和上传目录执行，提交后的数据库记录与刷新结果一并断言。新增 PBL 创建表单的实际提交、普通课程首次注入失败后的草稿保留与真实 AI 生成发布、课堂白板文字实际保存及重进；[PBL 草稿](evidence/final-production-functional/teacher-pbl-draft-created.png)、[AI 课程入库](evidence/final-production-functional/teacher-normal-ai-generated-published.png)和[课堂编辑器重进](evidence/final-production-functional/teacher-classroom-editor-real-saved.png)截图均已人工核对。真实 DOCX 的两处知识点、原文证据和关系在 [浏览器图谱](evidence/final-production-functional/teacher-textbook-real-graph.png)中绘制并刷新保持；学生 AI 会话用 DeepSeek 生成答复，随后从 API 和数据库重新读取。此处的“通过”仅对应报告列出的操作，不能替代尚未完成的 OpenMAIC 流式 UI 与完整 PBL 课程发布链路。

中途有一次把部署构建复制到不同运行目录的尝试，静态资源路径仍指向原构建名，隔离实例因此返回 CSS/JS 404；该轮 [日志与截图](evidence/final/functional-reuse-invalid.log)保留作环境问题证据，不计为产品回归。随后改为独立生产构建，最终本轮达到 73/73。

补充图谱验收初轮把测试 DOCX 的知识点误设为节标题，解析器按既定“章—节—知识点”层级只产出章节，初轮 [日志](evidence/final/functional-extended.log)与 [报告](evidence/final/functional-extended/report.json)保留为无效测试样本。用解析器直接核对并修正标题层级后，此项在最终独立构建中再次通过。

复用既有正式生成的单节样本，浏览器将两页实际课件逐页绘制并测量，均无页面问题；[两页截图与测量记录](evidence/generated-artifact-render-artifacts/generated-course-render-re-b4dad-rds-page-level-measurements-chromium/render-report.json)可供人工复核。同一类样本的九段真实语音完成了整节学生课堂预览、暂停续播和测验，[播放日志](evidence/lesson-playback.log)记录 4.5 分钟的实际播放。样本并非可发布的完整课程，正式发布到学生端的数据库闭环仍为阻塞。

补充故障注入在生产页面上验证了学生课程请求断网、教师课程请求超时后的提示和重试，以及封面资源 404 时的占位图，[2/2 通过](evidence/fault-recovery.log)。学生公开讨论在浏览器拒绝麦克风后显示错误，并可切换文字提交，[1/1 通过](evidence/microphone-permission.log)，[拒绝](evidence/microphone-denied.png)与[恢复](evidence/microphone-text-fallback.png)截图已人工查看；讨论接口使用故障夹具，不能据此推断真实讨论持久化。课堂计时器从现行“工具”入口完成继续、暂停、调时和重计，[定向复验](evidence/timer-retest.log)通过。三引擎还分别用十种窗口复查了中英文长标题和超长链接，[补充矩阵](evidence/long-copy/)30/30 通过。

外部能力最小调用见 [providers/report.json](evidence/providers/report.json)：DeepSeek 文本、通义语音合成、语音识别、图片生成和 Ollama 向量服务实际成功；PDF 解析服务、视频生成、网页搜索无已启用配置，状态为“阻塞”。PDF 的本地上传/下载/展示、WebM 的浏览器播放与这些外部服务配置项分别统计。该外部调用预检复用了本轮早期隔离生产构建，最终版的普通业务功能由最后的独立构建再验一次。

按 [覆盖清单](coverage.md)统计，当前为 66 项通过、7 项阻塞、3 项不适用，最终复验中没有未处理的已执行失败。阻塞项为完整 PBL 课程生成与正式发布到学生端、OpenMAIC 页面流式对话及中途断流恢复、未配置的 PDF 解析服务/视频生成/网页搜索、Windows/macOS 与原生缩放/输入法实机，以及 Node.js 22 目标运行时一致性。普通课程 AI 生成入库、课堂白板真实保存和视频自动播放拒绝恢复已通过，但不能代替上述缺口。因此目前不能签署“全功能及所有电脑均可上线”的结论；压测和并发测试按计划留待专项。
