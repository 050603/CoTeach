# 最终验收后的本机备份与隔离恢复操作单

2026-09-27 更新，**本页不是最终恢复通过报告**。用于最终候选版本完成后的 40 人验收运行；以下 `CAPACITY_FINAL_RUN_ID` 必须指向主任务确认的最终运行，不能复用已清理的历史运行。必须等待持续负载、最终归档、重启、对账及 runner 退出均完成，才执行手动备份和隔离恢复。既有定时备份照常运行。

## 执行前提

1. 主任务确认最终 runner 已退出、在途业务请求与浏览器操作已经结束。检查最终 `report.json` 的 `outcome` 和 `updatedAt`；主 runner 没有 `finishedAt` 字段，不能用探针的字段替代。`failed` 可以保留完整恢复证据，不能改成 `passed`；终止在中途的阶段仍须标明未执行。
2. 最终逐学生数据库、附件、媒体及 AI 对账已完成，相关成功和失败报告保留；此时仍未删除任何测试数据。恢复成功不代表先前丢失的数据已补回，也不能覆盖质量失败结论。
3. 本机 Docker、Python 3、rsync 可用；正式 PostgreSQL 和 WAL 接收器仍正常运行，镜像仍在本机。备份默认位于 `/home/lkj/OpenPBL/openPBL/.openpbl-data/local-backup`，目标容器/数据库仍使用已安装服务的配置。不要重新执行 `setup`，不要改复制槽、停止数据库、切换应用连接或停止定时器。
4. 磁盘有足够空间容纳新增快照及完整隔离副本。`backup` 只强制检查至少 10GiB 空闲；这不是 `drill` 副本空间足够的证明，执行前还需结合当前基础备份与应用文件体量判断。此项现场检查也等最终运行结束后进行。
5. 执行命令不包含 `restore-latest.sh`、`restore-drill.sh` 或手动云备份。这些旧入口属于其他恢复流程；本轮只使用 [local-backup.py](../../../deploy/backup/local-backup.py)，不增加云端传输。

## 命令及证据位置

新验收证据位于 `.openpbl-data/capacity-evidence/`，独立于 Playwright 可清空的 `test-results/`。历史报告仅在原文件仍存在时可显式使用旧路径；不得以数据库当前内容伪造丢失的请求确认清单。

以下在仓库根目录、同一个 Bash 会话逐步执行；每步失败即停止，查明原因后再继续。所有输出保留在该 run 的 `backup-restore/`，不覆盖主报告。

```bash
cd /home/lkj/OpenPBL/openPBL
set -euo pipefail
umask 077
capacity_run_id="${CAPACITY_FINAL_RUN_ID:?Set the completed final capacity run ID first}"
capacity_run_dir="$PWD/.openpbl-data/capacity-evidence/$capacity_run_id"
capacity_backup_evidence="$capacity_run_dir/backup-restore"
capacity_backup_root="${OPENPBL_LOCAL_BACKUP_DIR:-$PWD/.openpbl-data/local-backup}"
mkdir -p "$capacity_backup_evidence"
```

先保存主报告身份及“此后创建恢复点”的时间界限。该命令只读主报告，不复制个人过程内容；人工完成通知仍是前提，报告非 `running` 本身不能证明后台操作已结束。

```bash
python3 - "$capacity_run_dir/report.json" "$capacity_backup_evidence/context.json" <<'PY'
import hashlib, json, sys, time
from pathlib import Path
source = Path(sys.argv[1]); raw = source.read_bytes(); report = json.loads(raw)
assert report['outcome'] in ('passed', 'partial', 'failed'), 'Runner has not reached a terminal outcome'
assert report['runId'] == source.parent.name
context = {'runId': report['runId'], 'reportOutcome': report['outcome'],
           'reportSha256': hashlib.sha256(raw).hexdigest(), 'runnerUpdatedAt': report['updatedAt'],
           'actualSoakSeconds': report.get('actualSoakSeconds'), 'notBeforeEpoch': time.time()}
Path(sys.argv[2]).write_text(json.dumps(context, indent=2) + '\n')
PY
python3 deploy/backup/local-backup.py status > "$capacity_backup_evidence/status-before.json"
python3 deploy/backup/local-backup.py backup 2>&1 | tee "$capacity_backup_evidence/backup.log"
```

`backup` 与定时服务共用非阻塞文件锁。已有备份占锁时，命令会打印跳过提示且可能退出 0，**不能因此认定新检查点已生成**。下面必须确认成功回执指向本次界限之后的完整快照；若失败，应先等待当前备份结束，再重试 `backup`，不停止现有服务。

```bash
python3 - "$capacity_backup_root" "$capacity_backup_evidence" <<'PY'
import json, sys
from pathlib import Path
root, evidence = map(Path, sys.argv[1:])
context = json.loads((evidence/'context.json').read_text())
receipt = json.loads((root/'status/last-success.json').read_text())
manifest = json.loads((root/'snapshots'/receipt['snapshot']/'manifest.json').read_text())
assert receipt['startedEpoch'] >= context['notBeforeEpoch'], 'No new acknowledged checkpoint after the final run'
assert manifest['startedEpoch'] == receipt['startedEpoch']
(evidence/'checkpoint.json').write_text(json.dumps(receipt, indent=2) + '\n')
PY
python3 deploy/backup/local-backup.py status > "$capacity_backup_evidence/status-checkpoint.json"
python3 scripts/verify-capacity-local-restore.py "$capacity_run_dir/report.json" --require-source \
  2>&1 | tee "$capacity_backup_evidence/drill.log"
cp "$capacity_backup_root/status/last-drill.json" "$capacity_backup_evidence/restore.json"
python3 deploy/backup/local-backup.py status > "$capacity_backup_evidence/status-after.json"
```

[逐运行恢复工具](../../../scripts/verify-capacity-local-restore.py) 调用原 `drill`，只在隔离库完成全表校验之后、删除临时副本之前，增加本轮 40 人的最终草稿、全部确认保存回执、归档版本、学习事件 ID 及恢复文件 SHA 校验。每个校验连接通过 `PGOPTIONS` 强制默认只读，并验证该设置；输出存入 `capacityVerification`。本次最终恢复必须携带 `--require-source`，缺少源码快照、源码校验失败或 DOCX worker 构建输入缺失都不得通过；恢复结果保留 `sourceRecovery.applicationRebuilt=false`，源码与构建输入完整性不等于已执行应用重建。媒体先验证原始上传与磁盘 SHA，再额外执行与播放路由一致的 `normalizePlayableWav`，核对报告中的 `servedSha256`、已记录的 `servedSize`、时长及课堂音频引用；不能用播放响应 SHA 取代原文件 SHA。旧报告缺少播放证据时明确输出 `not-recorded`，不能据此声称已验证播放响应。

默认 `python3 deploy/backup/local-backup.py drill` 仍可用于不指定某一验收运行的通用演练。

`drill` 没有指定 snapshot 的命令行参数；它在取得同一文件锁后选择最新完整快照。若定时器恰好生成了更新快照，演练可以使用更新的配套恢复点，必须按 `restore.json.snapshot` 记录实际恢复对象，不能假称一定恢复了 `checkpoint.json.snapshot`。锁被占用时演练返回非零，应等待后重试；不能复制旧 `last-drill.json` 当作本次成功。

最后用实际恢复快照核对时间界限、RPO/RTO 和计数，生成不含配置正文或学生数据的摘要：

```bash
python3 - "$capacity_backup_root" "$capacity_backup_evidence" <<'PY'
import datetime, hashlib, json, sys
from pathlib import Path
root, evidence = map(Path, sys.argv[1:])
context = json.loads((evidence/'context.json').read_text())
checkpoint = json.loads((evidence/'checkpoint.json').read_text())
restored = json.loads((evidence/'restore.json').read_text())
manifest = json.loads((root/'snapshots'/restored['snapshot']/'manifest.json').read_text())
assert restored['completedEpoch'] >= context['notBeforeEpoch'], 'Stale restore report'
assert manifest['startedEpoch'] >= context['notBeforeEpoch'], 'Restored checkpoint predates the final run boundary'
assert restored['physicalWalRecovery'] is True
assert restored['sourceRecovery']['verified'] is True
assert restored['sourceRecovery']['workerBuildInputsVerified'] is True
assert restored['sourceRecovery']['applicationRebuilt'] is False  # Source integrity only; no rebuild in this drill
assert 0 <= restored['recoveryPointAgeAtStartSeconds'] <= 900, 'RPO exceeds 15 minutes'
assert restored['rtoWithin60Minutes'] is True and restored['durationSeconds'] <= 3600
assert restored['tablesVerified'] == len(manifest['tables'])
assert restored['rowsVerified'] == sum(row['count'] for row in manifest['tables'].values())
assert restored['filesVerified'] == len(manifest['files'])
assert restored['assetsVerified'] == len(manifest['assets'])
capacity = restored['capacityVerification']
assert capacity['sourceRecoveryVerified'] is True
assert capacity['runId'] == context['runId'] and capacity['studentsVerified'] == 40
assert capacity['readOnlyRestoredDatabase'] is True and capacity['sourceOutcome'] == context['reportOutcome']
report_bytes = (evidence.parent/'report.json').read_bytes()
assert hashlib.sha256(report_bytes).hexdigest() == context['reportSha256'], 'Run report changed during recovery verification'
summary = {**context, 'checkpointSnapshot': checkpoint['snapshot'], 'restoredSnapshot': restored['snapshot'],
           'snapshotStartedAt': datetime.datetime.fromtimestamp(manifest['startedEpoch'], datetime.timezone.utc).isoformat(),
           **{key: restored[key] for key in ('durationSeconds', 'recoveryPointAgeAtStartSeconds', 'tablesVerified',
              'rowsVerified', 'filesVerified', 'assetsVerified', 'physicalWalRecovery', 'rtoWithin60Minutes')},
           'fileCategories': {name: sum(path.startswith(prefix) for path in manifest['files']) for name, prefix in
              [('uploads', 'files/uploads/'), ('classrooms', 'files/classrooms/'), ('whiteboards', 'files/whiteboards/'),
               ('auditOutbox', 'files/ai-audit-outbox/'), ('capacityEvidence', 'files/capacity-evidence/'), ('configuration', 'configuration/')]},
           'sourceRecovery': restored['sourceRecovery'], 'capacityVerification': capacity,
           'productionDataOverwritten': False, 'applicationConnectionSwitched': False}
(evidence/'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary))
PY
```

确认 `drill` 正常退出、其唯一 `openpbl-local-drill-<PID>` 容器与本次 `drills/<timestamp>` 副本已清理，保留所有快照和证据。如果失败，不把旧演练或部分步骤写成通过；保留现场，不自动扩大到生产恢复。

## 结果解释及后续顺序

- `backup.log` 的 `snapshot`、`checkpoint.json` 和 `restore.json` 分别记录创建与实际恢复的快照；完整数据库、配置和文件仍在私有 `snapshots/<timestamp>/`。不要将 `configuration/`、原始数据库或完整文件清单复制到公开报告。
- 演练逐表比较完整行内容摘要，并验证全部文件 SHA-256 和数据库上传引用；这包括快照内的最终压测记录。它不替代 runner 的逐学生业务对账，也不证明后续生产数据不会变化。
- RPO 取演练开始时配套快照的年龄，目标 ≤900 秒；RTO 取校验、隔离复制、WAL 回放、逻辑恢复及对账总耗时，目标 ≤3600 秒。正式应用连接切换未演练，同盘副本不覆盖整机或磁盘丢失。
- 无论业务质量结论通过或失败，均保留主报告原结论。**只有最终备份和恢复证据确认后，才进入逐 UUID 测试数据清理**，操作见 [清理说明](cleanup.md)。不能以删除测试记录替代解释失败。
