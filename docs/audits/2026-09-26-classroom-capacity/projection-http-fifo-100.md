# FIFO 部署后真实投屏100样本与状态读取对照

2026-09-27，正式运行版本 **EDqknReUN8EtLXtwvSkeg**。校园内网172.16.185.157，保留https://coteach.cn Host/TLS。独立UUID课程、40学生、2教师、42真实WebSocket，无模拟接口；仅测试fixture数据。运行代码全程未变更。以下结果为真实接口，不是隔离数据库性能。

## 结论

**一致性全部通过，性能仍未达标。** 不能将FIFO降低重试量解释为已满足课堂延迟目标。全部100次投屏均送达42/42订阅者，40份草稿最终100版，4000条学习心跳与回执逐一对账，无接口错误。原报告以latency-failed退出1保留：`test-results/capacity/capacity-32fbcba7-bde7-484d-bc87-42faf8f7c747/report.json`，以及逐轮日志（本机证据：`projection-http-fifo-100-failure.log`）。

| P95 | FIFO前正常实践 | FIFO后正常实践 | FIFO前额外压力 | FIFO后额外压力 |
| --- | ---: | ---: | ---: | ---: |
| 投屏HTTP | 1389ms | 1281ms | 3027ms | 1703ms |
| 最慢WS到达 | 1388ms | 1283ms | 3029ms | 1702ms |
| 草稿保存 | 3493ms | 3102ms | 7259ms | 6070ms |
| 状态读取 | 1181ms | 1010ms | 2550ms | 1856ms |
| 学习心跳 | 3545ms | 3079ms | 7329ms | 6005ms |
| 测验提交 | — | — | 7296ms | 6174ms |
| 进度提交 | — | — | 7266ms | 6227ms |

正常实践每轮同时40保存、40state读取、40心跳，共50轮；额外压力另加40quiz和40progress，共50轮，跨阶段极限压力单独解释，不冒充正常课堂频率。教师在每批开始90–989ms分布发送投屏。FIFO后总体投屏P95为1632ms、最大1896ms；正常实践最大投屏1366ms、保存3800ms、读取1224ms、心跳3780ms。约定投屏P95≤500ms、保存/心跳≤2000ms、普通读取≤1000ms，本轮正常实践均未达到；1010ms不能四舍五入声称达标。

## 运行指标：重试风暴消失，延迟尚在

430次脱敏采样（本机证据：`projection-http-fifo-runtime-samples.jsonl`），UTC19:05:41至19:13:33。只记录SQL类别、PG活动/等待和指标，不记录正文、口令、令牌。

- FIFO前旧采样约119秒内busy累计增加113864；本轮约472秒内只增加118（11→129）。样本窗口不同，只用于量级对照。
- FIFO队列最高142，无队列容量拒绝；最大advisory等待者仍仅1。
- 采样同时active PG连接最多12，idle-in-transaction最多4；后者已结束query等待客户端下一句的时长最高5077ms。不能由此直接断言连接池饱和，单个采样也不能分摊每条请求的等待。
- eventloop P99峰值172.5ms；max峰值1758ms出现在首个采样，属于该采样窗口累计值，不应当作每轮延迟；仍可见数百毫秒调度停顿。

## 去掉40次state读取的独立短对照

相同部署与相同50场景seed结构，新UUID课程；仍同时40保存+40心跳+42WS，仅去掉每轮40次GETstate。20轮、20投屏全部42/42送达，800草稿写与800心跳正确，40份最终20版；无HTTP错误。报告`test-results/capacity/capacity-032960ea-38e7-47d5-b7a8-e1c11205ecd3/report.json`，以latency-failed退出1，原报告保留；日志（本机证据：`projection-http-fifo-no-state-failure.log`）、指标（本机证据：`projection-http-fifo-no-state-metrics.jsonl`）。

| P95 | 有state正常实践50轮 | 无state诊断20轮 |
| --- | ---: | ---: |
| 投屏HTTP | 1281ms | 798ms |
| 最慢WS到达 | 1283ms | 798ms |
| 保存 | 3102ms | 2416ms |
| 心跳 | 3079ms | 2383ms |

无state最大投屏974ms、保存2717ms、心跳2697ms。指标busy增加24、FIFO排队最高73，无队列拒绝。该指标文件未获得PG活动行，不能将空行解释为数据库没有活动。由于20/50轮历史长度不同，本对照不是严格同一数据库快照A/B，但明确支持读取扩散会增加混合负载延迟；同时证明单独去掉state仍不足以满足投屏500ms、保存2秒门槛。

复现命令：

```sh
CAPACITY_CONNECT_HOST=172.16.185.157 PROJECTION_CONTENTION_ROUNDS=50 pnpm exec tsx scripts/verify-projection-http-contention.mjs
CAPACITY_CONNECT_HOST=172.16.185.157 PROJECTION_CONTENTION_ROUNDS=20 PROJECTION_CONTENTION_MODES=draft PROJECTION_CONTENTION_INCLUDE_STATE=0 PROJECTION_DEPLOYMENT_ID=EDqknReUN8EtLXtwvSkeg pnpm exec tsx scripts/verify-projection-http-contention.mjs
```

## 后续最小投屏查询优化及验证

原投屏链路：路由JWT/session版本校验和限流→通用User/template/offering/深层instance/teacher查询→专用事务advisory→row锁→receipt查询→instance/runtime查询→两次原子写→发布。投屏并未loadCourse整课，但连续SQL受应用调度与池等待叠加影响。本次没有逐阶段span，不能宣称已量出鉴权占用了多少毫秒。

修复只改projection分流：通用预读由专用事务原advisory及row锁之后的**一个新语句**代替，一并读取最新runtime、offering、账户status/role/sessionVersion、当前CourseTeacher membership及旧receipt。先重新鉴权再重放；教师原锁、课程版本、投屏控制、两次原子写保持。其他action仍走原授权路径。独立锁语句和锁后新快照保留，避免等待行锁的旧语句快照覆盖新runtime。

27个projection/submission相关单测、相关ESLint通过。新增独立完整迁移PostgreSQL工具`node scripts/verify-projection-authorization.mjs`，只接受127.0.0.1临时无密码Docker数据库及随机nonce表；真实PG证据（本机证据：`projection-hotpath-authorization.log`）通过：

- 禁用账户、角色变化、sessionVersion撤销、移除任课教师，均同时拒绝新请求和旧成功receipt重放。
- 外课程/不存在课堂拒绝，不泄露或重放已有receipt。
- 实际确认请求已排在课程advisory锁后，再撤销教师；释放锁后，重放重新读取当前授权并拒绝。
- 显式接管与单调courseVersion；DomainEvent插入注入故障后runtime和版本完整回滚；无关runtime字段保留。

日志内`projection-receipt-fault`为刻意注入且已断言的回滚测试，工具退出0并清理容器。优化尚需统一构建部署后的真实HTTP验收；本节不将数据库正确性验证表述为延迟达标。
