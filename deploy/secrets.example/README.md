# 部署 Secret 配置

在服务器创建 `deploy/secrets/`，目录权限 `0700`，各文件权限 `0600`。该目录保持 Git 忽略；应用由 [openpbl-production-service.sh](../../scripts/openpbl-production-service.sh)读取凭据，Compose 按相应服务挂载。具体服务与端口见[部署说明](../README.md)。

## 应用与数据库

| 文件 | 内容 |
| --- | --- |
| `postgres_password.txt` | PostgreSQL 用户的随机密码。 |
| `database_url.txt` | 实际目标数据库 URL；密码进行 URL 编码。 |
| `jwt_secret.txt` | 长随机 JWT 密钥，至少 43 字符。 |
| `provider_encryption_key.txt` | 32 字节随机值的 base64；已有 Provider 凭据依赖原密钥。 |
| `monitor_token.txt` | 至少 32 字符的内部监控与运行器鉴权令牌。 |

当前宿主网络覆盖配置使用 `postgresql://openpbl:<URL-ENCODED-PASSWORD>@127.0.0.1:15432/openpbl?connection_limit=30&pool_timeout=10`。普通 Compose 网络内的迁移容器使用 `postgres:5432`；宿主进程不能使用该容器 DNS 名称。根据实际进程与网络选择地址，不混用本地开发的 5432 和宿主生产的 15432。

升级和恢复保留原 JWT 与 Provider 加密密钥，并检查待执行迁移及对应备份。凭据文件正文不写入构建输出、验证报告或工单。

## 可选监控与手动精简备份

- `grafana_admin_password.txt`：独立 Grafana 管理员密码；启用监控时使用。
- `s3_access_key.txt`、`s3_secret_key.txt`：手动精简备份存储的受限访问凭据。
- `restic_password.txt`：独立高熵 Restic 密码，服务器之外保留副本；遗失后不能解密存储中的备份。
- `load_test_admin_token.txt`：Compose 中保留的兼容 Secret；当前[容量工具](../../tests/load/README.md)使用真实登录和限定测试身份，不使用退役的压测写入 API。

Compose 在 `deploy/.deploy.env` 读取域名、镜像与存储配置，其中 `OPENPBL_MIGRATOR_IMAGE` 为匹配发布版本的迁移镜像，`PUBLIC_HOST` 为域名，手动备份需要 `BACKUP_S3_ENDPOINT`、`BACKUP_S3_BUCKET`、可选 `BACKUP_S3_REGION` 与明确的 `MANUAL_BACKUP_OFFERING_ID`。必需变量插值在 Compose 解析时检查；即使仅启动部分服务，也需核对合并后的配置。

本机完整备份读取已安装服务与实际存储配置，不向云端上传；手动精简备份的范围与命令见[备份说明](../backup/README.md)。
