# 第三轮100样本与后台任务轮询CPU定位

2026-09-27，部署 **cR2JODvJPc4rdn0Ss_go7**，含学生timing范围、教师投屏锁后单次鉴权查询、学生减少两次数据库往返。运行代码在以下正式负载和CPU诊断期间保持冻结。

## 正式100次真实HTTP/42WS：正确性通过，延迟失败

与[上一轮](projection-http-fifo-100.md)同规格，校园内网172.16.185.157、coteach.cn Host/TLS、独立UUID课堂、40学生+2教师。正常实践每轮40草稿+40state+40心跳；额外压力加40测验+40进度，两模式各50轮。100投屏全部42/42送达，40份草稿最终100版，4000心跳逐一对账，错误0。原失败报告保留：`test-results/capacity/capacity-c7e8224f-9060-405a-8407-fb22c729fdea/report.json`；日志（本机证据：`projection-http-hotpath-100-failure.log`）。

| P95 | 正常实践 | 额外跨阶段压力 |
| --- | ---: | ---: |
| 投屏HTTP | 1235ms | 1727ms |
| 保存 | 2960ms | 5626ms |
| 状态读取 | 1084ms | 1766ms |
| 心跳 | 2913ms | 5561ms |
| 测验 | — | 5674ms |
| 进度 | — | 5693ms |

总投屏P95 1577ms、max1987ms；最慢WS接收者P95 1578ms、max1988ms。最大advisory等待者1。正常实践保存≤2秒、读取≤1秒、投屏≤500ms均未达到，工具退出1。保存只有小幅改善，不能继续以未验证假设大范围调整。

399次PG/指标采样（本机证据：`projection-http-hotpath-metrics.jsonl`），UTC19:33:14至19:40:25：busy增加100，队列最高141、容量拒绝0；eventloop P99峰181.4ms。首采样max1774ms属于累计窗口，不能认为每笔都阻塞这么久。没有逐请求阶段span，不声称已精确分摊连接池或CPU等待。

## 授权诊断：空闲10秒与匹配实践负载

正式负载结束并关闭采样后，确认9229原来未监听，目标PID694553是当前`openpbl.service`的Next子进程且属于当前release。仅对该进程SIGUSR1开启127.0.0.1 inspector，先空闲采样10.66秒，再运行12轮相同practice负载采样43.73秒。1ms采样间隔。结束安排inspector.close后断开本次WS，确认9229关闭、原进程未重启、health200。

可复现工具：`scripts/verify-projection-cpu-profile.mjs`。原始产物`test-results/capacity/cpu-diagnostic-1790451649024/`内有两个`.cpuprofile`、独立诊断负载日志与manifest；不修改正式失败报告。**诊断带分析器开销，不能用其延迟替代正式验收。** profile只有函数栈与时间，无学生正文/令牌/密钥。聚合数据（本机证据：`generation-job-profile-summary.json`）。

| self time | 空闲10.66s | 负载43.73s | 空闲每秒 | 负载每秒 |
| --- | ---: | ---: | ---: | ---: |
| Prisma Hm | 506ms | 2293ms | 47.5ms | 52.4ms |
| Prisma parseEngineResponse | 434ms | 2226ms | 40.7ms | 50.9ms |
| 全部Prisma JS self | 955ms | 7346ms | 89.6ms | 168.0ms |
| GC | 385ms | 1446ms | 36.1ms | 33.1ms |
| `(program)` | 2622ms | 8888ms | 246.0ms | 203.3ms |
| `(idle)` | 6683ms | 19038ms | 627.0ms | 435.4ms |

`(program)`没有可用JS归属，不能直接归因为Prisma、数据库或某个JSON操作。GC每秒未随负载明显增加。空闲仍有约88ms/秒的两个Prisma JSON解析函数，说明不能把这部分都归因于40次state读取。

已直接检查Prisma6.19.3源码：`Hm`是带类型值解码，其中Json执行JSON.parse；`parseEngineResponse`执行JSON.parse引擎响应。CPU异步栈从`singleLoader/request`到root即截断，不能直接追溯所有请求的业务caller。但同一空闲profile同时采到以下可识别业务栈：

- release chunk68760.js column4052函数`b`，对应`job-storage.ts`的`findIn`，generationJob.findMany→map→filter。
- 同chunk column5895，updateMany事务内先findIn再逐条update。
- provider初始化与解密也出现，但self总计约1–2ms，不能与解析热点等量解释。

## 已核实的后台扫描原因

原`src/lib/course-generation/job-storage.ts:66`仅将字符串id/courseId/status下推；`findIn`加载所有匹配jobType的完整行后在JS处理OR/AND、status in、日期和JSON租约。

`course-generation/job-runner.ts:876`和`course-design/job-runner.ts:3584`的claimNextJob每1500ms执行包含OR分支的queued/running/review_available候选查询。顶层没有字符串status，导致全部历史任务连同request/result/trace加载。资源包worker虽也轮询，但其字符串status已经可下推，不应把它视作同规模扫描。

只读正式数据库聚合（不读取或输出正文）确认：content62条终态任务，JSON文本合计43.07MiB；design67条合计10.34MiB，其中2条review_available共0.27MiB，其余均非queued/running。该规模与空闲解析热点一致，是明确可修复的背景开销；不能据此保证修复后课堂门槛自动通过。

## 最小修复与隔离PG证据

只改job-storage候选过滤，递归下推OR/AND和直接存储字段的状态in/not、原生日期/空值等。JSON派生值、step默认值等仍交给原`matches`。SQL候选必须是原匹配集合的超集：OR含不可转换分支时保守保留整条OR，nullable not保留NULL分支，uppercase负向status不错误排除小写投影值。不提前take，避免首行租约未到而后续可用任务被漏掉。原返回全对象、创建/更新、advisory锁和CAS事务不变，不停用后台worker、不删除历史。

23相关单测、ESLint通过；`node scripts/verify-generation-job-polling.mjs`在完整迁移、127.0.0.1专用随机Docker和nonce数据库执行，日志（本机证据：`generation-job-polling-pg.log`）退出0：

- 44条新旧结果严格相等，含pending/running、OR/AND、空分支、null/not/原生日期、JSON残余、升降序以及残余筛选后第一条；无提前take改变结果。
- 62条大历史+15条状态样本，共77行48,392,150字节；原worker候选全读，对照6轮P95（6样本即最大）762.68ms；新路径实际driver只返回6行3003字节，4.22ms。
- 全终态历史时仍执行轮询，但实际返回0行、0任务payload。
- 两事务同时领取同一queued任务仅一个成功；更新保留其他JSON字段。
- updateMany第2行触发故障，先前更新完整回滚。日志中的`polling-update-fault`是预期故障注入。

该性能数字来自隔离数据库，不是正式HTTP门槛；统一构建部署后必须重新执行同规格100样本。运行代码已冻结，未自行部署。

首次全量typecheck发现JobWhere中OR/AND数组联合类型尚未收窄，失败原日志（本机证据：`generation-job-polling-typecheck-initial-failure.log`）保留。随后仅补充Array.isArray排除，23相关单测和ESLint再次通过；最终统一生产构建已通过（编译84秒、全量TypeScript103秒、25份CSS与运行数据隔离检查通过）。2026-09-27 03:56已部署 `9gBYgTHvMYT79SK_VJaXK`，live/ready真实依赖与首页、教师登录均200。真实课堂并发复测进行中。

后续统一build全量类型及部署检查已通过，版本9gBYgTHvMYT79SK_VJaXK。其真实100样本已完成，数据正确、读取达标但密集同步burst保存/心跳/投屏仍超门槛，见[最终短测记录](projection-http-polling-100.md)。
