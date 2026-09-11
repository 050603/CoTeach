# OpenPBL 单系统生产部署

生产环境只运行当前系统。Next.js 应用、代码运行器和本地问卷分词服务由 systemd 用户服务托管；Docker Compose 只负责 PostgreSQL、Redis、Nginx、数据库迁移以及可选的监控和备份服务。

## 更新流程

1. 备份 PostgreSQL、上传文件、课堂数据和 `deploy/.deploy.env`。保留原 `PROVIDER_ENCRYPTION_KEY` 与 `JWT_SECRET`。
2. 在仓库根目录运行 `python3 scripts/setup-survey-nlp.py` 准备本地分词环境，再运行 `pnpm install --frozen-lockfile && pnpm build`。
3. 运行 `pnpm exec prisma migrate deploy`。
4. 安装或更新 `deploy/systemd/` 下的应用、代码运行器和 `openpbl-survey-nlp.service`，执行 `systemctl --user daemon-reload` 后重启服务。
5. 检查应用 `/api/health/live` 和分词服务 `http://127.0.0.1:3003/health/live`，并完成教师登录、学生加入与五阶段课堂冒烟测试。

`pnpm start` 会从 `.next-build` 创建 `.openpbl-runtime/releases/<BUILD_ID>` 不可变运行目录，避免下一次构建覆盖正在服务的版本。

## 问卷词云分析

教师可在个人中心的问卷词云设置中切换「本地分词」和「大模型分析」。选择按教师账号保存至数据库，默认保持本地分词；更改只影响当前教师查看问卷时的分析方式。

本地模式使用 HanLP `COARSE_ELECTRA_SMALL_ZH:20220616` 上下文分词模型，不加载自定义领域词典。普通虚词只在词云展示阶段过滤，不改变模型分词边界。它保留按训练语料定义的词边界，不保证把所有多词概念合并为一个短语。

大模型模式复用 AI 服务设置中的默认语言模型及连接配置，结合题意提取原文概念。只发送题目和回答文本，不附带学生姓名或账号；程序校验回答编号和原文依据，按学生去重计算频次，避免模型直接生成统计数字。大模型首次分析在后台完成，每批最多 8 份回答，每个应用进程最多 2 个并发请求，与本地推理队列分开；失败显示不可用并延迟重试，不静默切换分析方式。

安装脚本建立 `.openpbl-runtime/nlp-venv`，复用宿主 Python 的已安装依赖，并按 `deploy/survey-nlp-requirements.txt` 安装缺失版本。需要 Python 3.10 或以上；首次安装会下载并校验模型及分词资源，之后资源位于 `.openpbl-runtime/nlp-models`。受限网络可在运行安装脚本时设置 `HTTPS_PROXY`。运行服务完全离线，缺少模型资源会启动失败，不会自动联网下载。

模型常驻 CPU，使用两线程，暖机后仅监听回环地址 3003；Nginx 不开放该端口。应用默认通过该地址访问，可通过 `OPENPBL_NLP_URL` 指定其他本机回环入口。两种模式的回答按题目、内容和模型配置分别缓存至 Redis（7 天）；同一回答重复刷新不重新分词。普通请求最多等待本地推理 500 毫秒，大批量任务继续后台处理并保留已有词云，界面显示已分析份数。长文本分片有重叠，频次仍按不同学生去重统计。

词云以横排文字围绕中心紧凑排布，同频词保持相同字号；空间不足时重排，字号过小时改为可换行、滚动的完整词条。后端保留全部已验证词，首屏优先覆盖不同学生，超过 48 词通过分页或搜索查看。看板默认显示全部原回答，题目右上角的“全部回答”按钮可清除词条筛选。分析和覆盖数量保留在接口中，不在页面展示；没有提取到关键词不等于没有收到回答。

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
