# 最终验收工具对账修复（2026-09-27）

本轮仅修改验收工具与测试，未修改运行代码、构建部署或运行数据库/HTTP负载。工具已冻结，供后续两人冒烟及42人120分钟验收使用；本记录不代表长时容量验收通过。

## 已补齐的门槛与证据

- 普通授课答疑、文档AI与主观批阅分别统计首轮失败率，要求各自低于0.5%，不使用状态轮询等HTTP请求稀释分母。重试成功仍保留首次失败；操作清单数量、完成状态与耗时必须完整。
- 每名学生主观批阅（含显式重试）累计完成时间不得超过60秒；失败后恢复仍记录每次业务结果。服务端审计中的历次状态需与HTTP观察一致。
- 主观批阅原始输出使用运行端 `parseQuizGradeResponse` 解析，所得分数与反馈必须匹配终态，避免仅验证SHA而漏掉错误评分。
- 文档AI模型原文必须归属于已完成任务的当前调用token和文档版本。普通讨论还核验当前调用成功输出的稳定事实key，旧失败调用的原文不能替代最终成功调用原文。
- 协议请求与真实浏览器学习事件均须获得明确 `acceptedIds` 回执，保存完整原请求用于最终核验。最终逐项核对事件原文指纹、正文、时长、时间、课堂及学生/选课/研究归属；允许运行端既有课程标题与知识点标签补充。

既有整体性能门槛和文档评论质量失败逻辑保持原样。

## 本轮验证

以下命令60项测试全部通过，完整输出见 final-acceptance-integrity-tests.log（本机证据：`final-acceptance-integrity-tests.log`）：

```sh
node --test scripts/capacity-ai-gates.test.mjs scripts/verify-capacity-learning-records.test.mjs scripts/verify-capacity-ai-records.test.mjs scripts/verify-capacity-grading-records.test.mjs scripts/verify-capacity-extensions.test.mjs scripts/verify-capacity-projection-browser.test.mjs scripts/verify-capacity-browser-records.test.mjs
```

相关改动工具及测试文件的 `pnpm exec eslint ... --max-warnings 0` 通过；`pnpm exec tsx scripts/verify-classroom-capacity.mjs --help` 成功加载入口后退出，未访问数据库或请求生产API。生产评分解析器由工具直接导入，未复制另一套评分规则。

回归包括：恢复成功仍使独立首轮失败率超标、累计61秒批阅被拒、原文分数不符、最终调用缺原文但有旧原文、HTTP200缺事件ACK、事件ID存在但原文/归属/时间被破坏。
