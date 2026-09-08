# OpenPBL 单系统生产部署

生产环境只运行当前系统。Next.js 应用和代码运行器由 systemd 用户服务托管；Docker Compose 只负责 PostgreSQL、Redis、Nginx、数据库迁移以及可选的监控和备份服务。

## 更新流程

1. 备份 PostgreSQL、上传文件、课堂数据和 `deploy/.deploy.env`。保留原 `PROVIDER_ENCRYPTION_KEY` 与 `JWT_SECRET`。
2. 在仓库根目录运行 `pnpm install --frozen-lockfile && pnpm build`。
3. 运行 `pnpm exec prisma migrate deploy`。
4. 安装或更新 `deploy/systemd/` 下的应用和代码运行器服务，执行 `systemctl --user daemon-reload` 后重启服务。
5. 检查 `/api/health/live`，并完成教师登录、学生加入与五阶段课堂冒烟测试。

`pnpm start` 会从 `.next-build` 创建 `.openpbl-runtime/releases/<BUILD_ID>` 不可变运行目录，避免下一次构建覆盖正在服务的版本。

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

每个 GitHub environment 配置 `DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_HOST_KEY` secrets，以及绝对路径变量 `DEPLOY_PATH`。服务器需具备 Node.js、pnpm、Git、flock、curl，能够从 origin 拉取提交，并已安装指向该路径的两个用户服务及所需 secrets。不同环境使用独立用户或主机，不能共用同一组生产服务。

首次安装服务时，将 `deploy/systemd/` 模板中的路径、域名与端口改成目标环境配置，再安装到用户 systemd 目录。CI 更新不覆盖这些环境配置。默认健康检查访问 3000 端口；非默认端口通过 GitHub environment 变量 `DEPLOY_PORT` 设置，并与服务配置一致。

部署 checkout 必须干净（凭据和运行数据应保持忽略），并允许切换到 detached HEAD。执行前完成上文要求的备份。脚本以 Git 锁防止同一 checkout 同时更新；构建失败不会重启当前服务。应用服务启动时执行已提交迁移，健康检查失败会明确退出；数据库迁移后不自动回滚旧代码，需根据迁移兼容性恢复。实际入口为 `bash deploy/deploy-systemd.sh <完整提交SHA> <项目绝对路径> [应用端口]`。
