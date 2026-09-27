# 本机完整备份与手动精简备份

## 本机课堂恢复点

`local-backup.py` 在 `.openpbl-data/local-backup/` 保存完整课堂数据，目录权限为 `0700`。**它不调用云端存储或现有手动备份。** 同一磁盘上的副本可处理误删、应用错误和数据库逻辑损坏，不能应对整机或磁盘丢失。

- PostgreSQL 每日基础备份，使用当前数据库的同一个本机镜像（含 pgvector），并运行 `pg_verifybackup`。
- `openpbl-local-wal.service` 持续同步接收 WAL；专用复制槽保留 WAL，上限 4 GiB，接收器长期离线时避免无限占用生产磁盘。超限丢失 WAL 后必须重新建立基础备份，状态检查不会继续报告健康。
- 每 5 分钟生成完整逻辑数据库快照（包括账号、所有学习过程、AI 对话、原始答案与实践版本），在同一 MVCC 快照记录每张表的行数和内容摘要。目录格式按表压缩，未变化的表数据复用前一快照的硬链接，避免重复保存大型教材与向量表。
- 同时保存全部 uploads、classrooms、whiteboards、AI 审计待补写队列和运行所需配置/密钥，使用硬链接复用未变化的文件；SQLite 使用在线备份 API。待补写队列在数据库快照之前复制，确保消费中的事件至少存在于队列副本或后续数据库快照。为所有文件生成 SHA-256，并按数据库的 `FileAsset` 引用检查上传内容，任何缺失或摘要不符均不得确认成功。
- 只清理超过 30 天的备份，保留覆盖最早恢复点所需的前一个基础备份及 WAL；不会删除业务原始数据。配置和凭据只存在私有备份目录，不写入报告。

主机需要 Docker、Python 3 和 rsync，无需安装额外 Python 包。默认连接本机 `openpbl-postgres-1` 容器的 PostgreSQL 16、端口 15432、数据库 `openpbl`，使用现有 localhost trust 规则。非此部署需通过 `OPENPBL_BACKUP_POSTGRES_CONTAINER`、`OPENPBL_BACKUP_POSTGRES_PORT`、`OPENPBL_BACKUP_DATABASE` 和 `OPENPBL_BACKUP_DATABASE_USER` 指定目标，并检查数据库访问规则。

首次安装（下列 units 使用本仓库现有宿主机绝对路径；其他主机先替换路径）：

```bash
python3 deploy/backup/local-backup.py setup
install -m 0644 deploy/systemd/openpbl-local-{wal.service,backup.service,backup.timer,backup-health.service,backup-health.timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openpbl-local-wal.service
systemctl --user start openpbl-local-backup.service
python3 deploy/backup/local-backup.py status
systemctl --user enable --now openpbl-local-backup.timer
systemctl --user enable --now openpbl-local-backup-health.timer
```

`setup` 创建专用复制角色和槽，通过 `ALTER SYSTEM` 将 `max_slot_wal_keep_size` 设置为 `4GB` 并热加载，不重启正式数据库；此设置对该数据库实例的所有复制槽生效。新增其他复制消费者前应重新评估上限。服务故障可从 `journalctl --user -u openpbl-local-backup.service -u openpbl-local-wal.service` 查看；不要删除生产数据卷。

日常检查：

```bash
python3 deploy/backup/local-backup.py status
python3 deploy/backup/local-backup.py drill
python3 -m unittest discover -s tests/deploy -p test_local_backup.py -v
```

`status` 在完整恢复点超过 900 秒、复制槽不可用或接收器离线时返回非零退出码。恢复点时间采用逻辑快照开始时间，不采用备份完成时间，以免高估 RPO。状态位于 `status/last-success.json`，恢复演练证据位于 `status/last-drill.json`。目标 RPO ≤15 分钟、RTO ≤60 分钟，必须以实际演练结果确认，定时器存在本身不代表达标。

`openpbl-local-backup-health.timer` 每分钟独立检查恢复点、WAL 接收器及备份服务/定时器状态，不依赖应用或 Prometheus。异常时 `openpbl-local-backup-health.service` 返回失败，详情写入 `status/health.json`；状态或原因变化才写一条 journal 事件，不发送任何外部通知。可用 `journalctl --user -u openpbl-local-backup-health.service` 查看；恢复后下一轮自动清除告警状态。

`drill` 首先检查所有备份文件与数据库引用的 SHA-256，然后将基础备份复制到唯一的隔离目录，在 **无网络、无宿主机端口、无生产卷挂载** 的容器中回放 WAL 到备份的命名恢复点；再将逻辑快照恢复到隔离容器的新数据库，并逐表对比全部行的内容摘要。报告只含时间、计数和校验结果。结束后删除该次演练容器与临时数据库副本，保留备份和报告。物理恢复点略晚于逻辑快照；精确表对账以逻辑快照为准，文件与逻辑快照是完整配套恢复点。

SQLite 在线备份必须在计算文件清单前显式关闭源、目的连接；Python 连接的 `with` 仅提交事务，不代表关闭。否则临时 WAL/SHM 会进入清单并在垃圾回收后消失。非空 WAL-mode 隔离回归同时检查连接回收后的清单稳定性及独立只读恢复内容。

实际恢复时先运行演练验证所选备份，再在维护窗口停止应用写入；将所选逻辑快照恢复到新的数据库实例并还原同一快照下的 `files/`、`configuration/`，验证后切换应用连接。不要直接覆盖仍在运行的生产目录。若只进行物理 PITR，必须另检查命名恢复点与文件之间的新引用差异；持续 WAL 本身不能替代配套文件快照。配置目录含敏感信息，不能上传到代码仓库或附在工单中。

本次 42 人容量验收结束后的准确执行顺序、锁冲突判断、证据位置和 RPO/RTO 核对见 [最终备份与恢复操作单](../../docs/audits/2026-09-26-classroom-capacity/final-backup-restore-runbook.md)。该操作单需等待持续负载、最终归档、重启与对账全部结束后再执行，不代表最终恢复已通过。测试自建数据只在新恢复证据确认后清理；投屏探针须显式指定 `--kind=projection-contention`，详见 [清理说明](../../docs/audits/2026-09-26-classroom-capacity/cleanup.md)。

## 手动精简备份（保留原有流程）

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
