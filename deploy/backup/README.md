# Backup and recovery

生产环境的 `backup` profile 与当前单机 host-network 部署一致：

- 每 10 分钟用 `pg_dump -Fc` 生成在线一致性数据库导出；
- 用 SQLite 在线备份接口复制白板数据库；
- 将数据库导出、白板副本、不可替代的上传文件、课堂脚本和非派生媒体作为同一 Restic 快照加密上传；
- 默认不重复备份可从已保存配方恢复的 TTS 音频与 PPTX 课堂 PDF 预览；
- 每日仅保留最近 24 小时内的恢复点和 7 个每日恢复点，并执行仓库元数据检查；
- 只有完整快照成功上传后才更新 `backup-status` 指标。

## 数据分级

`FileAsset` 明确记录 `assetRole`、`backupPolicy`、`sourceAssetId`、
`regenerationRecipe` 和 SHA-256。当前分级如下：

| 数据 | 策略 | 恢复方式 |
| --- | --- | --- |
| PostgreSQL、课堂 JSON、白板 SQLite | 必须备份 | 原样恢复 |
| 教师/学生上传、成果文件 | `REQUIRED` | 原样恢复并用 SHA-256 校验 |
| 课堂图片、视频和封面 | 必须备份 | 当前尚未具备完整、稳定的重建配方 |
| 课堂 `audio/` TTS | `REGENERATE` | 从 `speech.text` 和场景 TTS 配方重新合成 |
| PPTX 课堂 PDF 预览 | `REGENERATE` | 从原始 PPTX 重新转换 |
| 临时文件、无引用旧产物 | `EPHEMERAL` | 不恢复，由清理任务回收 |

备份器不会只按扩展名排除文件。每个课堂排除音频前都会解析 JSON：只要
存在“有音频引用但无原文”的片段，该课堂音频就回退为完整备份。原始上传
也不会因为 MIME 类型与 TTS 相同而被排除。快照内的
`staging/current/recovery/` 保存重建队列和精确的省略字节数。

紧急情况下可在 `deploy/.deploy.env` 设置
`BACKUP_INCLUDE_REGENERABLE_ASSETS=true`，生成包含所有派生产物的完整快照。

首次启动：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  --profile backup up -d --build volume-backup
```

检查日志与状态：

```bash
docker compose --env-file deploy/.deploy.env \
  -f docker-compose.prod.yml -f docker-compose.ip.yml \
  logs --tail=100 volume-backup
docker inspect openpbl-volume-backup-1 --format '{{.State.Health.Status}}'
```

Bucket 必须保持私有并阻止公共访问。RAM 凭据仅允许访问指定备份 Bucket；
Restic 密码必须在服务器之外另存一份，否则对象仍在也无法解密。

每天 03:30（随机延迟不超过 15 分钟）运行 `openpbl-data-cleanup.timer`：

- 删除超过 24 小时且没有数据库记录的上传文件；
- 删除超过 7 天、已软删除且没有成果引用的上传文件；
- 删除超过 24 小时且没有有效课堂版本引用的课堂 JSON、媒体和旧封面；
- 被已发布课堂、课堂历史记录或当前生成任务引用的文件始终保留。

安装或更新定时器：

```bash
install -Dm0644 deploy/systemd/openpbl-data-cleanup.service \
  "$HOME/.config/systemd/user/openpbl-data-cleanup.service"
install -Dm0644 deploy/systemd/openpbl-data-cleanup.timer \
  "$HOME/.config/systemd/user/openpbl-data-cleanup.timer"
systemctl --user daemon-reload
systemctl --user enable --now openpbl-data-cleanup.timer
```

每月在隔离卷中执行恢复演练：

```bash
CONFIRM_RESTORE_DRILL=openpbl-restore-drill-data \
  sh deploy/backup/restore-drill.sh
```

演练只会重新创建 `openpbl-restore-drill-data` 和
`openpbl-restore-drill-input` 两个明确命名的演练卷，不挂载或修改生产
PostgreSQL 数据卷。默认使用 `docker-compose.ip.yml`；其他部署可以通过
`OPENPBL_COMPOSE_OVERRIDE_FILE` 指定覆盖文件，或者显式设置为空。

## 实际恢复

文件和数据库恢复完成、数据库迁移应用后，先审计重建范围：

```bash
./scripts/openpbl-production-service.sh rehydrate-data \
  --manifest /恢复目录/staging/current/recovery --dry-run
```

确认 TTS 服务凭据和 LibreOffice 可用后执行重建；任务按课堂串行运行，并在
每个课堂后原子更新 JSON。若部分 TTS 成功后供应商失败，成功片段会保留，
再次执行只生成缺少的片段。

```bash
./scripts/openpbl-production-service.sh rehydrate-data \
  --manifest /恢复目录/staging/current/recovery
```

首次启用资源生命周期字段后，可为迁移前的原始文件补齐内容哈希：

```bash
./scripts/openpbl-production-service.sh rehydrate-data --backfill-hashes
```

恢复完成后再次执行 `--dry-run`，必须全部显示 `ready` / `present`，再开放
课堂入口。TTS 属于可恢复但不要求逐字节一致的派生产物：供应商模型变化时
音色或时长可能略有变化，课程脚本、学习记录与原始资源不受影响。

当前目标为核心数据 RPO 不超过约 15 分钟、RTO 不超过 60 分钟；派生资源
的可用时间取决于重建队列规模与 TTS 配额，恢复演练必须分别记录“核心数据
可用”和“派生资源全部重建”两个时间点。
