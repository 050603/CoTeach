# 覆盖清单

状态针对“操作”列所述的检查，不将页面出现等同于完成整条业务链。证据代号：`F` 为 [隔离数据库功能报告](evidence/final-production-functional/report.json)，`L` 为 [三引擎布局矩阵](evidence/final-production/summary.json)，`E` 为 [交互浏览器日志](evidence/final-production-interactive.log)，`P` 为 [外部服务报告](evidence/providers/report.json)，`U` 为 [应用测试日志](evidence/final-postfix-unit-full.log)。早期预检见 [preflight/report.json](evidence/functional/preflight/report.json)，复用了较早的隔离生产构建，不作为最终版通过依据。页面测试中的 JWT 和接口模拟只用于隔离布局/交互；真实业务链使用正式注册/登录得到的 cookie。

| 范围 | 角色 | 前置数据 | 操作 | 预期结果 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| 首页与角色入口 `/` | 公共 | 无 | 直达并选择角色 | 首页和入口正常显示、可进入登录 | 通过 | L：`home`；E：品牌入口交互 |
| 教师注册和登录 `/teacher/register`、`/teacher/login` | 教师 | 一次性账号 | 注册、登录、刷新 | 会话保持并进入课程管理 | 通过 | F：`teacher-register-real-login-cookie`；L：`teacher-login`、`teacher-register` |
| 学生邀请码加入和注册 `/student/register` | 学生 | 开放教学班与邀请码 | 验证邀请码、注册、登录 | 出现对应课程并写入报名 | 通过 | F：`student-invite-register-real-login-cookie`；L：`student-register-account` |
| 学生登录 `/student/login` | 学生 | 已注册账号 | 登录并返回深层链接 | 会话有效、返回目标页面 | 通过 | F：`student-password-reset-invalidates-session-and-relogin`、`expired-student-deep-link-redirects-to-login` |
| 学生密码重置 `/student/reset-password` | 学生 | 教师签发的重置 token | 重置、旧会话访问、新密码登录 | 旧会话失效，新密码可用 | 通过 | F：`student-password-reset-invalidates-session-and-relogin` |
| 旧账号接口 `/api/auth/login`、`/register`、`/join` | 双方 | 已迁移 V2 | 请求旧接口 | 410 与明确迁移提示 | 通过 | F：`legacy-account-api-explicitly-retired`；[隔离预检](evidence/functional/media-preflight/report.json) |
| 角色隔离、无效 ID 与过期会话 | 双方 | 教师、学生各一会话 | 越权请求、无效活动、注销后访问 | 401/404 与可恢复页面，不暴露数据 | 通过 | F：`role-boundaries-and-invalid-activity`、`teacher-logout-invalidates-session`、`student/invalid-activity-recovery` |
| 深层链接、刷新、前进后退与新标签页 | 双方 | 已登录的有效课程 | 直达、刷新、新标签打开课程并返回后再进入 | 保持正确角色与页面状态 | 通过 | F：所有 `teacher/*`、`student/*` 页面检查均直达并刷新；`student-deep-link-back-forward-new-tab` |
| 整页离线后恢复 | 学生 | 已登录会话 | 断网时整页刷新，联网后重试 | 会话及数据可恢复 | 通过 | F：`student-new-tab-shares-real-session-and-recovers-offline-reload`；断网期间由浏览器自身显示离线页，恢复后课程重新可见 |
| 首页旧地址 `/teacher`、`/student` | 双方 | 已登录 | 直达旧根路径 | 重定向当前课程入口 | 通过 | F：`redirect-/teacher`、`redirect-/student` |
| 教师课程列表 `/teacher/classes` | 教师 | 一门课程 | 打开、刷新、查看列表 | 课程可见且持久 | 通过 | F：`teacher/classes`、`teacher-and-student-reload-persisted-course` |
| 教师课程详情 `/teacher/classes/[offeringId]` | 教师 | 课程、章节、活动 | 打开、刷新 | 课程与活动可见 | 通过 | F：`teacher/course-detail`；L：`teacher-course` |
| 课程设置弹窗和访问旧地址 `/access` | 教师 | 已有课程 | 打开设置；直达旧地址 | 弹窗可达；旧地址重定向详情 | 通过 | L：`teacher-course-dialog`；F：`redirect-/teacher/classes/.../access` |
| 创建、开放教学班与章节 | 教师 | 新教师 | 创建并开放，刷新数据库 | 教学班和章节持久、学生可见 | 通过 | F：`teacher-course-chapter-invite-persistence`、`teacher-and-student-reload-persisted-course` |
| 教学班结课、归档与邀请码禁用 | 教师 | 已开放教学班 | 结课、归档、禁用邀请码，独立学生会话重查 | 状态持久，禁用的邀请码不能再加入 | 通过 | F：`teacher-finish-and-archive-course-persisted`、`teacher-invitation-disable-rejects-new-join`；邀请码到期时间单列未实测 |
| 邀请码到期时间 | 教师 | 已开放教学班 | 设置 3 秒后的到期时间，先预览，再过期预览和注册 | 到期后拒绝新加入且不创建账号 | 通过 | F：`teacher-invitation-expiry-blocks-preview-and-registration`；隔离数据库计数为 0 |
| 四类普通活动创建与开放 | 教师 | 开放章节 | 新增作业、测验、问卷、资源 | 四类活动有有效 ID 且可开放 | 通过 | F：`teacher-four-activity-types-created` |
| 课堂活动创建与开课 | 教师 | 已保存模板版本、开放章节 | 新增 Classroom 活动、开课 | 场次启动并允许学生进入 | 通过 | F：`classroom-create-start-enter-and-workspace-reload` |
| 学生成员与档案 `/teacher/classes/[offeringId]/students` | 教师 | 已加入学生 | 列表、档案抽屉、刷新 | 正确显示学生及学习记录 | 通过 | F：`teacher/students`；L：`teacher-student-detail` |
| 移出成员与学习记录导出 | 教师 | 已加入学生 | 导出 ZIP/CSV、移出学生、独立学生会话重查 | 文件可下载，已移出学生不再看到课程 | 通过 | F：`teacher-student-records-real-zip-export`、`teacher-withdraw-student-revokes-course-access`；历史记录删除策略未在本轮比较 |
| 前后测配置 `/teacher/classes/[offeringId]/activities/[activityId]/experiment` | 教师 | 课堂活动 | 直达、刷新 | 配置页正确显示 | 通过 | F：`teacher/experiment`；L：`teacher-experiment` |
| 问卷结果与投屏 `/teacher/surveys/[activityId]` | 教师 | 已提交问卷 | 打开统计、切换题型与投屏页 | 回答数一致，圆环/条形/柱形/文本均可见 | 通过 | F：`teacher-survey-sees-student-submission`、`teacher/survey`；L：`survey-*` |
| 课程库 `/teacher/templates` | 教师 | 已有模板 | 列表、刷新 | 模板可见 | 通过 | F：`teacher/templates`；L：`teacher-library` |
| 课程模板版本发布 | 教师 | 已有模板 | 创建第二个已发布版本并查数据库 | 版本号递增且旧版仍保留 | 通过 | F：`teacher-template-version-published-and-persisted`；[隔离预检](evidence/functional/media-preflight/report.json) |
| 普通创建 `/teacher/templates/new` | 教师 | 教师会话 | 打开创建表单 | 表单及导航可用 | 通过 | F：`teacher/template-create`；L：`teacher-template-new` |
| PBL 创建 `/teacher/templates/pbl/new` | 教师 | 教师会话 | 填写并提交创建表单，刷新备课页 | 草稿模板写入数据库且重进可见 | 通过 | F：`teacher-pbl-browser-create-draft-persisted`；[创建后截图](evidence/final-production-functional/teacher-pbl-draft-created.png)；L：`teacher-template-pbl-new` |
| 普通课程 AI 生成、失败重试与课程库发布 | 教师 | 已配置大模型、隔离教师账号 | 从表单填写、注入首次失败、刷新保留草稿、真实生成、预览、发布并刷新 | AI 生成课程方案及模板版本写入数据库，课程库可见 | 通过 | F：`teacher-normal-ai-generation-failure-retry-publish-persisted`；[发布后截图](evidence/final-production-functional/teacher-normal-ai-generated-published.png) |
| PBL 完整课程生成及失败重试 | 教师 | 有效教材、六阶段课时与 AI 配置 | 从已创建 PBL 草稿完成全量课堂生成，失败后重试并重进 | 全部阶段和资源持久，重试不丢已有成果 | 阻塞 | F 已验证 PBL 草稿、资源包解析和确认；真实单节生成产物参与预览，尚未完成本轮从草稿到可发布完整 PBL 课程的数据库闭环 |
| 教材库及阅读 `/teacher/textbooks`、`/teacher/textbooks/[id]` | 教师 | 隔离 DOCX 教材 | 上传、解析、搜索、阅读、刷新 | 解析结果与搜索证据持久可见 | 通过 | F：`textbook-docx-upload-parse-search-persistence`、`teacher/textbook-reader`；E：教材阅读与图谱交互 |
| 课程资料导入 `/teacher/prepare/[id]/verify` | 教师 | 模拟解析结果的资源包 | 上传控件、进度、校验、确认与冲突适配 | 校验不通过时不可生成，确认后发送版本绑定数据 | 通过 | L：`quick-preparation`；[资源包交互 4/4](evidence/package-generation-fixed.log) |
| ZIP/PPTX 资源包真实解析与课件转换 | 教师 | 有效三件套 ZIP | 真实上传、解析、PPTX 转 PDF、规划确认并重进 | 五阶段和一页课件正确保存，重进可见 | 通过 | F：`resource-package-real-zip-pptx-parse-pdf-confirm-persistence`、`teacher/resource-package-verified`；[隔离预检](evidence/functional/media-preflight/report.json) |
| 旧生成地址 `/teacher/prepare/[id]/generate` | 教师 | 有效课程 | 直达 | 跳转资料导入页 | 通过 | L：`generate-redirect` |
| 资料编辑 `/teacher/prepare/[id]/verify/edit` | 教师 | 有效课程 | 切换设计环节 | 编辑器可见、可切换 | 通过 | L：`preparation` |
| 授课资源 `/teacher/prepare/[id]/resources` | 教师 | 空资源课程 | 打开 | 空状态可见且可返回 | 通过 | L：`resources-empty` |
| 课堂编辑器 `/teacher/prepare/[id]/classroom-editor` | 教师 | 独立模板、课堂资源与教师会话 | 添加白板文字、保存、刷新并重进编辑 | 资源修订号递增，文件存储与模板关联保持，文字可继续编辑 | 通过 | F：`teacher-classroom-editor-browser-save-storage-reload`；[重进截图](evidence/final-production-functional/teacher-classroom-editor-real-saved.png)；E：编辑器交互 |
| 生成课件预览与逐页检查 `/teacher/prepare/[id]/preview` | 教师 | 既有真实生成的两页课件与九段真实语音 | 打开、完整播放、暂停续播、测验、逐页测量和查看截图 | 课件实际绘制，声音与学习流程可用，无内容裁切 | 通过 | [逐页测量 2/2](evidence/generated-artifact-render.log)、[两页截图和测量报告](evidence/generated-artifact-render-artifacts/generated-course-render-re-b4dad-rds-page-level-measurements-chromium/render-report.json)、[完整语音课堂播放](evidence/lesson-playback.log)；使用隔离浏览器夹具，不代表真实发布保存 |
| 正式课程发布闭环 `/teacher/prepare/[id]/preview` | 教师 | 可发布的完整生成课程 | 发布、持久化、学生进入新版本、失败重试 | 新版本在教师及学生独立会话中可见 | 阻塞 | 本轮真实生成产物为单节测试样本，产品禁止发布；模拟发布交互见 E，不能替代数据库闭环 |
| 开课设置旧地址 `/teacher/teach/[id]/setup` | 教师 | 已发布模板 | 直达与安排课堂 | 兼容当前 V2 模板/场次 | 通过 | F：`teacher/legacy-template-setup`；[隔离预检](evidence/functional/media-preflight/report.json) |
| 课堂页 `/teacher/teach/[id]/classroom` | 教师 | 教学中场次 | 直达、刷新、全屏、阶段/资源/学生面板 | 页面可操作，切换保存，弹层不遮挡 | 通过 | F：`teacher/live-classroom`；L：`teacher-classroom`；E：五阶段、投屏、反思、全屏拒绝 |
| 课堂记录 `/teacher/classrooms/[instanceId]` | 教师 | 已完成场次 | 查看记录、刷新 | 学生成果可见 | 通过 | F：`teacher/classroom-record` |
| 历史旧地址 `/teacher/teach/[id]/history` | 教师 | 已完成场次 | 直达 | 历史记录或明确退役提示 | 通过 | F：`teacher/legacy-classroom-history`；[隔离预检](evidence/functional/media-preflight/report.json) |
| 学生课程列表 `/student` | 学生 | 已报名课程 | 列表、刷新 | 课程与进度可见 | 通过 | F：`student/courses`；L：`student-courses` |
| 学生课程详情 `/student/courses/[offeringId]` | 学生 | 章节和五类活动 | 打开、刷新、菜单、章节展开 | 所有活动入口可见、无被遮挡菜单 | 通过 | F：`student/course-detail`；L：`student-course`、[4K 菜单复验](evidence/layout/chromium/course-4k-settled/summary.json) |
| 学生资料 `/student/profile` | 学生 | 已注册 | 打开、刷新、导航 | 个人资料可见 | 通过 | F：`student/profile`；L：`student-profile` |
| 学生普通活动 `/student/activities/[activityId]` | 学生 | 作业、测验、问卷、资源 | 页面编辑、提交、刷新 | 四类提交分别持久；教师统计可见 | 通过 | F：`student-*-browser-edit-reload`、`student-*-submit-reload` |
| 学生课堂 `/student/classroom/[id]` | 学生 | 教学中场次 | 进入、刷新、AI 讲授与个人信息 | 正确身份、课堂资源与控制可见 | 通过 | F：`student/live-classroom`、`classroom-create-start-enter-and-workspace-reload`；L：`student-player`、`dashboard-popover` |
| 学生课堂成果 `/student/participations/[id]` | 学生 | 已进入场次 | 文档/代码保存、成果提交、反思、刷新 | 工作区和成果持久 | 通过 | F：`classroom-create-start-enter-and-workspace-reload`、`classroom-artifact-stage-reflection-evaluation-finish`、`student/participation` |
| 教师学生成果 `/teacher/participations/[id]` | 教师 | 已提交成果 | 阅读、评价、刷新 | 评价对学生可见 | 通过 | F：`teacher/participation`、`classroom-artifact-stage-reflection-evaluation-finish` |
| AI 学习独立页 `/student/ai-learning/[id]` | 学生 | 课程与讲授资源 | 直达、播放控件、字幕栏 | 画面、字幕和播放控件可见 | 通过 | L：`student-standalone-player` |
| AI 协作页 `/student/ai-collaboration/[id]` | 学生 | 代码协作阶段 | 编辑器、文件弹窗、AI 组员 | Monaco 和工具面板可操作 | 通过 | L：`code` |
| V2 学生 AI 组员真实答复与持久化 | 学生 | 教学中课堂与有效大模型配置 | 建立会话、发送问题、读取答复和数据库记录 | 真实回复与学生问题均持久 | 通过 | F：`student-ai-real-reply-consumed-and-persisted`；DeepSeek 最小调用同轮成功；此项验证 API 及数据库，未宣称 OpenMAIC 流式 UI 已通过 |
| OpenMAIC AI 协作页流式对话 | 学生 | 教学中 AI 协作阶段 | 从页面发送消息、接收完整流式答复、刷新并继续 | 页面答复与学习状态持久 | 阻塞 | 页面、Monaco 和工具面板可见；完整流式 UI 与持久化未完成独立浏览器闭环 |
| 独立代码运行服务 | 学生 | 3002 端口服务 | Python/C 各执行最小程序，匿名调用 | 输出正确，未授权请求 401 | 通过 | [code-runner.json](evidence/code-runner.json) |
| PDF 上传、下载与 Range | 双方 | 隔离 PDF | 上传后读回并做范围请求 | 文件字节和范围响应正确 | 通过 | F：`pdf-upload-download-range-and-isolated-storage` |
| PDF/PPTX 课堂展示 | 双方 | 十页 PDF/PPTX 预览（模拟业务接口） | 翻页、同步、切换视图 | 10 页画布均实际绘制、保持比例及页码 | 通过 | [资源包课堂展示 2/2](evidence/package-launch-fixed.log)、[PDF 页码 4/4](evidence/pdf-retest-fixed.log) |
| 图片、音频、视频组件 | 双方 | 有效资源与缺失附件 | 渲染、上传下载、实际播放 | 图片可见，WAV/WebM 的浏览器播放推进 | 通过 | F：`audio-video-upload-download-browser-playback`；E：白板图片；L：图片完整性。损坏附件恢复另列下方故障行 |
| 知识图谱组件 | 教师 | 300 节点教材浏览器夹具 | 阅读、证据节点、全屏、键盘搜索 | Canvas 节点与证据可见、可退出 | 通过 | E：[交互浏览器组 78/78](evidence/final-production-interactive.log)；仅证明组件与浏览器交互 |
| 真实教材到知识图谱的完整链路 | 教师 | 隔离 DOCX 教材，含章、节和两个知识点 | 解析、核对原文证据、打开图谱并刷新 | 2 个真实节点、1 条关系和证据持久，Canvas 绘制可见 | 通过 | F：`textbook-real-docx-graph-and-evidence-persisted`；[真实图谱截图](evidence/final-production-functional/teacher-textbook-real-graph.png) |
| 白板表格/图片、图表、公式组件交互 | 教师 | 隔离接口夹具 | 编辑、渲染、模拟保存并刷新 | 图像/表格/8 种图表/KaTeX 实际可见且可操作 | 通过 | E：编辑器浏览器交互；真实白板文字的后端保存另见上方 F，本行不宣称图表与公式分别完成真实数据库闭环 |
| iframe、Worker、WASM 交互 | 学生 | Python 互动页 | 加载 Pyodide 并运行 `6 * 7` | iframe 收到 42，静态运行时资源可用 | 通过 | E：[Python 互动运行](evidence/final-production-interactive.log) |
| 课堂投屏与 PDF 页码恢复 | 教师 | 学生已批准成果 | 投屏、翻到第 2 页、重进 | 当前页从持久状态恢复 | 通过 | [PDF 最终构建复验 4/4](evidence/pdf-retest-fixed.log) |
| 全屏权限拒绝恢复 | 教师 | 模拟权限拒绝 | 点击全屏、Escape | 回退为沉浸窗口并可恢复 | 通过 | E：[全屏拒绝复验](evidence/final-production-interactive.log) |
| 麦克风权限拒绝与文字回退 | 学生 | 浏览器拒绝录音权限，公开讨论邀请模拟接口 | 接受麦克风、看到拒绝提示、改用文字提交 | 弹窗不消失，错误和回退入口可见，文字请求发出 | 通过 | [浏览器故障注入 1/1](evidence/microphone-permission.log)、[拒绝截图](evidence/microphone-denied.png)、[文字恢复截图](evidence/microphone-text-fallback.png)；只证明权限故障 UI，不计入真实讨论数据库闭环 |
| 摄像头权限拒绝 | 双方 | 本版无摄像头采集入口 | 无可操作项 | 后续增加视频采集时另行验收 | 不适用 | 本次源码入口搜索中 `getUserMedia` 仅请求 audio |
| 媒体自动播放受限恢复 | 双方 | 浏览器限制自动播放 | 注入视频首次 `NotAllowedError`，查看提示、分屏侧栏操作、点击重试并核对播放进度 | 明确提示，重试后视频实际推进 | 通过 | [Chromium](evidence/final-video-chromium.log)、[Firefox](evidence/final-video-firefox.log)、[WebKit 连续 3 次](evidence/final-video-webkit-repeat.log)；[拒绝](evidence/video-autoplay-denied-webkit.png)、[768 分屏](evidence/video-autoplay-denied-split-webkit.png)与[恢复](evidence/video-autoplay-recovered-webkit.png)截图 |
| 教师设置 `/teacher/settings` | 教师 | 教师会话 | AI 配置导航与表单展开 | 设置面板可见且不裁切 | 通过 | L：`teacher-settings-ai*` |
| 已配置外部 AI/语音/图片/嵌入服务 | 教师 | 服务密钥与隔离账号 | 最小真实调用 | 大模型、TTS、ASR、图片、向量结果可消费 | 通过 | [P：5 类实际成功](evidence/providers/report.json)；未启用的 PDF 服务、视频生成和网页搜索分别为“阻塞” |
| 未启用的 PDF 服务、视频生成、网页搜索 | 教师 | 当前配置中无可用服务 | 每类最小真实调用 | 能生成可消费结果 | 阻塞 | [P：3 类未发现已启用配置](evidence/providers/report.json)；不能当作调用通过 |
| 断网、超时、资源失败恢复 | 双方 | 浏览器故障注入 | 学生课程请求断网、教师课程请求超时、封面 404 后重试 | 明确提示，可恢复页面与缺失图片占位 | 通过 | [故障注入 2/2](evidence/fault-recovery.log)；教材解析、原文检索和资源补齐失败恢复另见 E |
| AI 流式响应中断恢复 | 双方 | 有效 AI 学习或生成会话 | 中途断开响应并重试 | 不丢已保存结果，无永久加载 | 阻塞 | 尚无完整浏览器级中途断流证据 |
| 键盘导航、焦点、Escape、滚轮 | 双方 | 阅读器、课堂浮层 | Tab/Enter/Escape、滚动和全屏退出 | 焦点可达，浮层可关闭，正文与控件可滚动 | 通过 | E：[教材与课堂交互](evidence/final-production-interactive.log)；原生中文输入法另列实机缺口 |
| 空数据、长标题、中英文混排、超长链接、多条目 | 双方 | 边界模拟数据 | 打开各列表、课程介绍、弹窗及 4K/分屏状态 | 无意外横溢、重叠、裁切 | 通过 | L：空资源、长中文标题、六门课程及问卷多选项；[长链接补充矩阵](evidence/long-copy/)：三引擎各 10 窗口零失败 |
| 原生 Windows/macOS、浏览器缩放、中文输入法 | 双方 | 实机 | 100/125/150/200% 与组合输入 | 页面可用、输入不丢字 | 阻塞 | [实机补验单](native-acceptance.md) 尚未执行 |
| 部署运行时版本一致性 | 运维 | 仓库声明 Node.js 22 / pnpm 10.4.1 | 在目标版本重建并复验关键链路 | 与上线目标运行时一致 | 阻塞 | 本机实际 Node.js 24.19.0、命令行 pnpm 9.9.0；本轮构建与测试不等于 Node.js 22 实测 |
| 压测、并发、长期稳定性 | 双方 | — | 本轮不执行 | 另行专项 | 不适用 | 用户指定排除 |
| 内部可视复核页 `/__visual-review/*`、`/internal/*`、`/visual-review-course-publish` | 内部 | 审查构建 | 产品验收范围外 | 不影响正式用户页面 | 不适用 | 路由清单核对 |

以上每项的页面适配状态最终还须结合 `L` 三引擎矩阵；对只用模拟接口的条目，不把业务持久化列为已通过。针对无截图的真实 API 检查，以 `F` 的报告条目和浏览器可重跑脚本作为证据。测试脚本和日志本身不会验证 Windows/macOS 实机环境。
