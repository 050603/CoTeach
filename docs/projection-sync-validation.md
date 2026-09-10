# 课堂投屏同步验收

`pnpm test:projection-sync` 使用一个教师浏览器上下文和 30 个相互独立的学生上下文，持续切换已加载资源的页码、滚动位置、视频播放状态、进度和倍速。每次操作从教师请求发出开始计时，到各学生页面完成对应投屏版本的 React 渲染为止。

运行前准备一个正在授课、当前阶段包含 PDF/PPT 或视频资源的测试课堂，并分别保存教师和 30 名学生的 Playwright `storageState`。学生目录中的每个 JSON 必须属于不同账号；脚本会通过 `/api/auth/me` 检查并拒绝重复身份。

```bash
PROJECTION_COURSE_ID='<课堂 ID>' \
PROJECTION_TEACHER_STORAGE_STATE='/absolute/path/teacher.json' \
PROJECTION_STUDENT_STORAGE_DIR='/absolute/path/students' \
pnpm test:projection-sync
```

默认参数为 30 名学生、运行 1800 秒、每 1200 毫秒一次操作、同步目标 1000 毫秒。以下环境变量可调整或扩展验证：

- `PROJECTION_BASE_URL`：默认 `http://127.0.0.1:3000`。
- `PROJECTION_RESOURCE_ID`、`PROJECTION_STAGE_KEY`：指定测试资源和阶段；缺省时读取当前课堂。
- `PROJECTION_BLOCK_WEBSOCKET=true`：阻断学生 WebSocket，单独验证 150 毫秒 HTTP 补漏路径；WebSocket 已订阅时保留 400 毫秒完整性检查。
- `PROJECTION_DURATION_SECONDS`：调试时可缩短，正式验收保持 1800。
- `PROJECTION_METRICS_TOKEN`：提供内部监控令牌后，在报告中保存测试前后的进程及 HTTP 指标。
- `PROJECTION_REPORT_PATH`：默认写入 `tests/load/reports/projection-sync-report.json`。

验收报告包含整体和逐学生的 P50/P95/P99、最大时延、超时次数、页面错误以及可选服务指标。只有所有有效最终操作都不超过 1000 毫秒且没有页面错误时，命令才返回成功。正式验收分别运行正常 WebSocket 场景和阻断 WebSocket 场景；完全断网不计入在线同步时延，恢复联网后重新运行一次操作验证追平。
