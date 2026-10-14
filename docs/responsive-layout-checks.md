# 多终端界面稳定性检查

`scripts/check-desktop-layout.mjs` 使用实际本机页面与浏览器内数据夹具，覆盖首页、师生登录注册、课程列表与详情、教师课程设置弹窗、学生课程返回导航/提醒弹层/账号菜单、个人中心、学生名单及详情、课程库、问卷填写和四类统计图表（含展示模式）。

## 运行

先完成生产构建和本机服务同步，再验证实际运行产物：

```bash
node scripts/check-desktop-layout.mjs --assert
```

默认使用 Chromium，检查 10 个桌面分辨率、平板横竖屏、390/320 像素手机横竖屏。移动设备使用对应的 User-Agent、触控与移动视口配置，每个场景重新访问页面；登录旋转场景还检查横竖切换后学号输入值仍保留。WebKit 可单独运行：

```bash
LAYOUT_BROWSER=webkit LAYOUT_DEVICES=pad-portrait,pad-landscape,phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

可按场景和设备缩小回归范围：

```bash
LAYOUT_SCENARIOS=home,student-login-rotation,teacher-course-dialog LAYOUT_DEVICES=phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

`--source-css` 将工作区平台样式加入页面，只适合构建前检查；上线验收应去掉此参数，确认服务加载的是构建产物。脚本只接受本机地址；可通过 `LAYOUT_BASE_URL` 选择其他本机端口。页面登录门禁使用本机 JWT 密钥签发不存在于数据库的夹具身份，密钥和 Cookie 不进入报告。

## 检测与证据

- 页面横向溢出、关键容器内容溢出、弹窗超出屏幕、文字云裁切、柱图交互宽度。
- 自然长中文标题的宽度和行数、意外文字溢出或被挤成极窄多行；明确配置的省略号和行数截断允许保留。
- 页面 JavaScript 异常、HTTP 失败资源、网络失败、可见图片加载与解码、资源耗时及传输体积。
- 首页和课程夹具使用仓库实际静态图片，图片资源经过应用真实服务加载。

结果持续写入 `/tmp/openpbl-responsive-*/report.json`，末尾生成 `summary.json`；失败场景及主要桌面/移动设备保存截图。`--assert` 在检测失败时返回非零状态。预期可横向滚动的内部容器不等同于页面溢出。

所有业务 API 都在浏览器内拦截：读取返回显式夹具，未定义读取和业务修改被记录并使检查失败；注册邀请码查询作为只读操作返回夹具。脚本不会创建账号、修改课程或提交真实作答。

这套检查验证所列页面、样例内容和浏览器引擎，不替代真实设备软键盘、安全区域、弱网、超大课件及生产数据的专项验收；资源耗时是本机测量值，不作为外网加载性能承诺。

## 内部教学与素材故障验证

```bash
node scripts/check-teaching-layout.mjs --assert
node scripts/check-image-stability.mjs
LAYOUT_BROWSER=webkit node scripts/check-image-stability.mjs
```

内部教学脚本覆盖备课生成与配置、课程发布预览、教师授课、学生课堂菜单、代码协作以及真实学生播放器。检查桌面、平板横竖屏、390/320手机横竖屏，包含步骤切换、文件管理、AI组员面板、页面目录收起和课堂菜单；同时检测画布被压扁、正文挤成竖排以及字幕与播放按钮裁切。`TEACHING_DEVICES` 和 `TEACHING_SCENARIOS` 可筛选受影响场景。

素材脚本在桌面和手机上主动模拟封面404、延迟响应和恢复URL，验证替代插画、图片解码以及卡片/封面/正文的位置与尺寸。预期注入的404与意外失败分开记录。图片失败时的替代显示保证页面可读，不代表已恢复远程原文件。

三个脚本均保留严格失败状态，生成本机临时JSON报告与截图；源码样式注入只用于定位问题，最终验证使用实际构建产物。WebKit的设备上下文不固定 `screen`，以便旋转测试同时更新布局屏幕尺寸；保留视口溢出和输入内容保持断言。

WebKit 检查需要浏览器系统依赖；页面与图片测试的通过不代表音视频播放和解码已验收，后者需要独立的播放证据。

## Chrome、Edge 与原生缩放

正式品牌浏览器验收必须指定真实可执行文件，不能用 Chromium 或覆盖 User-Agent 代替。隔离业务脚本、原生缩放测试及统一审计入口均核对可执行文件的 `--version` 和浏览器运行时身份；错标立即失败。

```bash
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
OPENPBL_RESOURCE_E2E_BASE_URL=http://127.0.0.1:3000 \
pnpm exec playwright test e2e/branded-native-zoom.spec.ts --workers=1
```

Edge 使用其实际路径与 `PRELAUNCH_E2E_BROWSER_LABEL=microsoft-edge`。原生缩放采用临时浏览器用户目录的原生页面缩放配置，固定外窗大小，验证 80%、100%、125%、150% 下实际 CSS 视口、DPR 和截图；不设置 CSS zoom、CDP pageScale 或模拟 viewport。测试包含师生登录、课程设置、学生问卷、真实播放器组件、助教错误与重试、中文输入组合态、焦点圈定与恢复，以及代码和文档协作保存错误与恢复。全部业务响应为浏览器内显式夹具，不能据此声称真实后端保存或真实 AI 通过。

统一布局入口支持顺序运行两个真实浏览器，并将 DPR 检查与等效缩放视口分别标记：

```bash
PRELAUNCH_BROWSERS=google-chrome,microsoft-edge \
PRELAUNCH_CHROME_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_EDGE_EXECUTABLE_PATH=/absolute/path/to/msedge \
PRELAUNCH_REUSE_BUILD=1 \
node scripts/run-prelaunch-audit.mjs --browser-only --with-zoom
```

`--with-zoom` 仅为等效视口回归；原生缩放仍使用上述 Playwright 测试。桌面默认包含 768×576、1024×576 等分屏和低高度场景；完整手机、平板矩阵可通过原有设备筛选单独运行。原生缩放并不等于 Windows/macOS 系统缩放或真机输入法、外接投影仪验收。

## 隔离业务、师生联动与真实 AI

`scripts/verify-prelaunch-functional.mjs` 启动一次性 PostgreSQL、Redis 和独立应用实例；数据库、上传文件、课件与 TTS 缓存均与运行中的系统隔离。`PRELAUNCH_REUSE_BUILD=1` 复用已经完成的生产构建，仍将 standalone 复制到临时运行目录；构建尚未结束时不能启动复制。执行需要 Docker、可用的对应镜像和本机空闲 3198 端口。

```bash
PRELAUNCH_REUSE_BUILD=1 \
PRELAUNCH_E2E_EXECUTABLE_PATH=/absolute/path/to/chrome \
PRELAUNCH_E2E_BROWSER_LABEL=google-chrome \
PRELAUNCH_REAL_PROVIDERS=1 PRELAUNCH_CLASSROOM_AI=1 \
PRELAUNCH_PROVIDER_SECTIONS=providers,tts,asr \
PRELAUNCH_OUTPUT_DIR=test-results/prelaunch/chrome-functional \
node scripts/verify-prelaunch-functional.mjs
```

Edge 单独运行到不同输出目录。真实供应商检查读取既有供应商配置，业务写入仍限于隔离实例。脚本沿用本机配置数据库凭据及出站代理；不可用时记录失败，不能将模拟响应计为通过。默认不执行整门课生成，只有显式 `PRELAUNCH_COURSE_GENERATION=1` 才启用该昂贵且不属于授课适配范围的场景。

默认关闭 WebSocket，浏览器通过 HTTP 轮询恢复课堂状态。设置 `PRELAUNCH_WEBSOCKET=1` 后，脚本独占三个 loopback 端口：3198 为浏览器同源代理，普通 HTTP 请求转发到隔离应用 3197，`/ws` 升级请求转发到隔离 WebSocket 服务 3199。WebSocket 使用同一次性 Redis 与数据库，代理仅绑定 `127.0.0.1`，不修改已安装的反向代理或主服务。多个浏览器运行必须顺序执行，三个端口均须空闲；退出时关闭代理和隔离实例。

WebSocket 模式要求教师和两个学生收到真实订阅确认与课堂事件，主动断开代理中的 TCP 连接，再验证离线学生联网后重新订阅并恢复投屏状态。`three-browser-websocket-evidence.json` 记录实际浏览器收到的消息类型，不使用 WebSocket 路由模拟。`three-browser-console-evidence.json` 按正常连接、主动断线及重连阶段保留浏览器错误；主动取消的状态读取被误报为同步失败时使联动检查失败，注入离线产生的真实网络错误另行记录。`three-browser-response-evidence.json` 保留失败接口及投屏、课堂操作的成功响应，便于区分版本冲突后的自动恢复与未处理错误。只补联动回归时可设置 `PRELAUNCH_LINKAGE_ONLY=1 PRELAUNCH_WEBSOCKET=1 PRELAUNCH_REAL_PROVIDERS=0 PRELAUNCH_CLASSROOM_AI=0`，跳过付费 AI 场景。

只补项目实践链路时使用 `PRELAUNCH_PRACTICE_ONLY=1 PRELAUNCH_REAL_PROVIDERS=0 PRELAUNCH_CLASSROOM_AI=0`，与联动子集或 AI 恢复模式分开运行。它复用隔离数据库和正式开课入口，在真实浏览器中新建 Python/C 文件、编辑保存、清除本机草稿后刷新、调用实际沙盒并核对教师读取的成果；编程工作区的保存直接持久化代码成果，当前没有独立的最终提交按钮。文档检查实际编辑、保存恢复、提交最终版、下载 Word 内容及提交状态持久化。运行器默认使用已有的 loopback `http://127.0.0.1:3002` 和 `deploy/secrets/monitor_token.txt`，可分别由 `PRELAUNCH_CODE_RUNNER_URL`、`PRELAUNCH_CODE_RUNNER_TOKEN_FILE` 指定；仅允许 loopback HTTP，且应等主服务部署及运行器重启完成后执行。代码运行无业务数据库写入，课堂、提交及文档仍只写隔离实例。

实践子集默认运行三种成果模式，可用 `PRELAUNCH_PRACTICE_MODES=python,c,document` 选择需要重验的模式；报告记录实际选择，局部结果不能代替未执行项。它关闭文档后台主动检查且不配置付费供应商；编程工作区自动发起的 AI 建议请求可能因未配置模型而失败，这些响应单列在 `browser-practice-evidence.json`，不计为模型验收，也不替代独立的真实课堂 AI 检查。编辑、保存、运行、提交和资源加载的其他错误仍使对应场景失败。

- 三会话联动使用一个教师、两个学生的独立登录态；教师通过页面开始投屏、翻页、停止投屏、切换阶段，学生验证逐页 PDF 课件实际画布、离线重连和刷新恢复。作答检查独立学生记录及教师读取到的真实进度。
- 课堂 AI 开关覆盖共享题目讲解、个人追问、文档与代码协作及公开讨论模型回应和总结。公开讨论中，被点名学生显示回答弹窗和 AI 当前回应；旁听学生不显示回答弹窗，读取同一讨论快照并暂停自主播放。两类学生按各自真实交互验证，不能要求旁听学生出现点名界面。公开讨论播放状态的 API 驱动会在证据中说明，不等同于语音控制界面验收。
- TTS 检查除了生成音频，还要求浏览器点击后解码并推进播放时间。ASR 使用明确标记的 TTS 合成测试音频；没有音频时标为未验证，不把配置探测当作真实识别。物理麦克风与扬声器未被覆盖。

`report.json` 保存浏览器身份、版本、构建编号、实际视口、传输方式及每项 `evidence` 分类，区分隔离后端、真实浏览器操作、供应商 API、媒体播放和注入故障。默认轮询结果不能作为 WebSocket 证据；可选 WebSocket 模式覆盖真实隔离传输和重连，不替代部署入口 TLS/反向代理检查或课堂容量测试。报告与截图写入已忽略的 `test-results/`，实际执行结果在交付说明中报告，不将未执行场景或旧报告沿用为本轮通过。

失败时脚本保留本次一次性数据库的 SQL 快照。需要单独复核已保存的公开讨论回应与收尾，可将 `PRELAUNCH_RESUME_AI_DIR` 指向该次报告目录并设置 `PRELAUNCH_RESUME_PUBLIC_DISCUSSION=1`，另选输出目录；只恢复合成验收账号及对应课堂的访问和阶段，不重新生成已保存的讲解与讨论回应。此模式仍需真实供应商配置来完成尚未执行的讨论总结。原报告与恢复报告分别保留，不能覆盖原始失败记录。
