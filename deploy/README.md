# CoTeach 单系统生产部署

生产环境只运行当前系统。Next.js 应用、代码运行器和本地问卷分词服务由 systemd 用户服务托管；Docker Compose 只负责 PostgreSQL、Redis、Nginx、数据库迁移以及可选的监控和备份服务。

## 更新流程

1. 备份 PostgreSQL、上传文件、课堂数据和 `deploy/.deploy.env`。保留原 `PROVIDER_ENCRYPTION_KEY` 与 `JWT_SECRET`。
2. 在仓库根目录运行 `python3 scripts/setup-survey-nlp.py` 准备本地分词环境，再运行 `pnpm install --frozen-lockfile && pnpm build`。
3. 运行 `pnpm exec prisma migrate deploy`。
4. 安装或更新 `deploy/systemd/` 下的应用、代码运行器和 `openpbl-survey-nlp.service`，执行 `systemctl --user daemon-reload` 后重启服务。
5. 检查应用 `/api/health/live` 和分词服务 `http://127.0.0.1:3003/health/live`，并完成教师登录、学生加入与五阶段课堂冒烟测试。

`pnpm start` 会从 `.next-build` 创建 `.openpbl-runtime/releases/<BUILD_ID>` 不可变运行目录，避免下一次构建覆盖正在服务的版本。

## 课程前置空间计算

新课程在成稿前使用 Playwright Chromium 加载播放器同源 Noto Sans SC 字体、CSS 和 KaTeX，计算文字、公式与表格容量，并按需生成区域草图。宿主部署首次安装运行 `pnpm exec playwright install chromium`；缺少系统库时由管理员安装 Chromium 依赖。已有系统 Chromium 可通过 `OPENPBL_CHROMIUM_EXECUTABLE_PATH` 指定完整路径。Docker 镜像已安装 Alpine Chromium 并设置该路径。精确度量会自动尝试配置路径、Playwright 自带浏览器与常见系统 Chromium，页面崩溃时重启重试。多次尝试仍失败时，仅当前空间计算切换到保守文本估算；草图截图不可用时继续传递已持久化的文本空间预算，不因辅助排版能力中断整门课程。

浏览器复用、默认单并发，空闲后释放；度量结果在进程内缓存。布局引擎 elkjs 仅提供关系图候选坐标，最终课程保持 OpenMAIC DSL。来源和版本见 [空间设计参考](../docs/slide-spatial-sources.md)。既有准备大纲和成功场景检查点不重新排版。

课程预览默认显示“未检查”；教师可主动检查，也可在权限、版本与资源完整性满足时直接确认发布。打开预览、生成完成和资源更新均不自动安排质量审核或重新生成。

## 问卷词云分析

教师可在个人中心的问卷主题云设置中切换「本地高频词」和「AI 主题聚合」。选择按教师账号保存至数据库，默认保持本地高频词；更改只影响当前教师查看问卷时的分析方式。

本地模式使用 HanLP `COARSE_ELECTRA_SMALL_ZH:20220616` 上下文分词模型，不加载自定义领域词典。普通虚词、问卷套话和泛化表达在展示阶段过滤，题干中的词降权，不改变模型分词边界。结果优先选择由多名学生提及的原词，再用信息量较高的单次词补足；它不合并同义表达。

AI 模式复用 AI 服务设置中的默认语言模型及连接配置。第一步为每份回答提取最多三个可在原文中验证的原子核心词，并拆开可独立统计的并列或复合表达；程序还会按并列位置去除“教育、课程、技术、领域”等语境后缀，但不会处理独立出现的完整概念。第二步在整道题内只归并严格同义、缩写或同一概念的措辞变体，相关概念、上下位概念和正反评价不得合并。同一回答中已经分别提取的不同证据不会被合成一个虚假主题。主题云不设十二词展示上限，主题名称必须选自第一步的原文证据，不能由模型创造或拼接。只发送题目、回答文本和匿名编号，不附带学生姓名或账号；程序校验证据映射并按学生去重计算频次，模型不生成统计数字。首次分析在后台完成，每批最多 8 份回答，每个应用进程最多 2 个并发请求，与本地推理队列分开；提词服务失败会显示不可用并延迟重试，语义归并返回局部格式异常时逐项清洗，完全不可用时继续用已验证的 AI 原词生成精确聚合词云，并在短期缓存后自动重试，不会切换到本地模式或隐藏整张主题云。

安装脚本建立 `.openpbl-runtime/nlp-venv`，复用宿主 Python 的已安装依赖，并按 `deploy/survey-nlp-requirements.txt` 安装缺失版本。需要 Python 3.10 或以上；首次安装会下载并校验模型及分词资源，之后资源位于 `.openpbl-runtime/nlp-models`。受限网络可在运行安装脚本时设置 `HTTPS_PROXY`。运行服务完全离线，缺少模型资源会启动失败，不会自动联网下载。

模型常驻 CPU，使用两线程，暖机后仅监听回环地址 3003；Nginx 不开放该端口。应用默认通过该地址访问，可通过 `OPENPBL_NLP_URL` 指定其他本机回环入口。两种模式的逐回答结果按题目、内容和模型配置缓存至 Redis（7 天）；AI 整题主题快照额外按全部回答摘要和提示词版本缓存。新增回答时可继续显示上一版主题，编辑或删除回答后不会复用不匹配的旧映射。普通请求最多等待本地推理 500 毫秒，大批量任务继续后台处理并保留已有主题云。长文本分片有重叠，频次仍按不同学生去重统计。

主题云展示全部经过排序和验证的词条，并围绕中心紧凑排布；不同学生的提及人数决定字号，同频词保持相同字号。常规数量使用碰撞布局，词数过多导致字号低于可读阈值时直接改为可滚动的完整词条并跳过碰撞计算，避免高密度场景拖慢页面。词云上方不显示状态或说明提示；看板默认显示全部原回答，点击 AI 归并后的原词主题时按已验证的学生映射筛选，题目右上角的“全部回答”按钮可清除筛选。

## 基础设施

IP/HTTP 部署使用：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  up -d postgres redis nginx
```

HTTPS 环境可按需启用 certificate、observability 和 backup profile。Nginx 只代理当前宿主机应用端口，不再创建旧版 blue/green 应用容器。

不要运行 `docker compose down -v`，因为 `-v` 会删除持久化数据卷。备份与恢复演练说明位于 `deploy/backup/`。

## GitHub Actions

手动触发 `.github/workflows/deploy.yml`，先执行共享验证，再通过 SSH 在服务器的专用 Git checkout 中部署本次 workflow 对应的完整提交 SHA。服务器自行构建应用，由已有 systemd 用户服务运行；不再发布旧应用容器或调用蓝绿脚本。

每个 GitHub environment 配置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_HOST_KEY` secrets，以及绝对路径变量 `DEPLOY_PATH`。服务器需具备 Node.js、pnpm、Python 3.10+、Git、flock、curl，能够从 origin 拉取提交，并已安装指向该路径的三个用户服务及所需 secrets。不同环境使用独立用户或主机，不能共用同一组生产服务。

首次安装服务时，将 `deploy/systemd/` 模板中的路径、域名与端口改成目标环境配置，再安装到用户 systemd 目录。CI 更新不覆盖这些环境配置。默认健康检查访问 3000 端口；非默认端口通过 GitHub environment 变量 `DEPLOY_PORT` 设置，并与服务配置一致。

部署 checkout 必须干净（凭据和运行数据应保持忽略），并允许切换到 detached HEAD。执行前完成上文要求的备份。脚本以 Git 锁防止同一 checkout 同时更新；构建失败不会重启当前服务。应用服务启动时执行已提交迁移，健康检查失败会明确退出；数据库迁移后不自动回滚旧代码，需根据迁移兼容性恢复。实际入口为 `bash deploy/deploy-systemd.sh <完整提交SHA> <项目绝对路径> [应用端口]`。
