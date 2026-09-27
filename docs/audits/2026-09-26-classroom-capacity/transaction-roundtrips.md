# 学生事务往返优化

状态：相关单测和隔离 PostgreSQL 通过，正式部署与 HTTP 混合负载待复验。

## 改动

`tryCourseMutationAdmission` 将非阻塞 PostgreSQL 事务咨询锁与事务内 `statement_timeout` 设置合成同一条 SQL。繁忙仍立即回滚，设置使用 LOCAL，不污染连接池。成功取得锁后仅在该 Prisma 事务对象上记录该课堂；`lockProjectedCourse` 可跳过同一事务已经持有的同一咨询锁，仍执行原 `ClassroomInstance FOR UPDATE` 行锁。教师、不同课堂及新事务保留原阻塞咨询锁路径，CAS、权限及闭课后的新鲜读取不变。

每笔低优先级写入省去两次冗余数据库往返；本进程 FIFO 与跨进程 PostgreSQL 锁继续生效。未改锁顺序、数据模型或超时门槛。

## 验证

- 25 项事务/会话测试与 64 项学习事件、进度、草稿、投屏依赖测试通过，ESLint 通过。
- 三个 Node 进程，40/120 次写入，所有版本/回执/投屏保留；教师样本最大 44/33ms。这是隔离测试，不能作为正式 HTTP 投屏 SLA。
- 6 个排队请求在约 10004ms 明确超时，无业务写入，队列清空。
- 长 SQL 约 1056ms 被 PostgreSQL 实际取消；残留查询 0，8 个池连接的 `statement_timeout` 均恢复 0。
- 40 名学生、14400 条历史事件的真实路由与 PostgreSQL：P95 1676ms、max 1754ms。重放、冲突、40 次故障注入原子回滚、闭课、禁用/角色/sessionVersion/退出验证通过。

同目录 `transaction-roundtrips-*.log` 保留完整证据。正式混合负载结果另报，不能用隔离通过替代。
