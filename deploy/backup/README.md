# 手动精简备份

生产环境不再自动向阿里云同步数据库、上传文件、课堂 JSON、白板或媒体，也不启用 PostgreSQL WAL 云归档。

管理员需要备份时，显式运行一次：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  --profile manual-backup run --rm --build manual-essential-backup
```

命令执行结束后容器退出，不设定时器、不循环运行。`MANUAL_BACKUP_OFFERING_ID` 必须指向正式课程；脚本会在范围不明确时失败，而不是扩大备份。

## 保存范围

加密 Restic 仓库使用 Bucket 内的 `openpbl-manual-essential/` 前缀，只保存：

- 正式课程选课学生的 `User` 完整记录，包括密码哈希、账号状态和会话版本；
- 正式课程本身、选课关系，以及满足外键恢复所需的最小课程结构；
- 第一章唯一 `FORM` 的定义和全部原始 `ActivitySubmission` 问卷提交；
- 当前数据库 schema、Prisma 迁移记录、校验和及恢复说明。

不会保存教师账号、测试课程、其他活动、课堂运行数据、上传文件、白板、课堂 JSON、媒体、AI 记录、日志或监控数据。

## 检查手动备份

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  --profile manual-backup run --rm --no-deps \
  --entrypoint sh manual-essential-backup -ec '
    export AWS_ACCESS_KEY_ID="$(tr -d "\r\n" < /run/secrets/s3_access_key)"
    export AWS_SECRET_ACCESS_KEY="$(tr -d "\r\n" < /run/secrets/s3_secret_key)"
    export RESTIC_PASSWORD_FILE=/run/secrets/restic_password
    restic -o s3.bucket-lookup=dns -o "s3.region=$AWS_DEFAULT_REGION" snapshots
  '
```

Restic 密码必须在服务器之外另存一份；密码遗失后云端加密数据无法恢复。恢复时先将快照还原到临时目录，再严格按照快照内 `RESTORE.txt` 操作。该备份不是完整生产环境恢复点。
