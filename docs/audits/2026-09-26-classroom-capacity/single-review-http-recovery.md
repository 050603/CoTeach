# 主动批注验收的有界HTTP恢复（2026-09-27）

本轮只修改 `scripts/verify-capacity-document-comments.mjs` 及测试，未修改运行代码、部署或调用额外模型。正式测试 d9198e99 中两次失败分别是：两次正向输出均缺 `evidenceSource`（`AI_RESPONSE_INVALID_STRUCTURE`）；一次原文不是合法JSON（`AI_REVIEW_INVALID_STRUCTURE`）。限定两名测试学生的只读查询确认，原文及失败终态均已完整留存，所有SHA一致，旧报告不变。

工具现在仅对明确HTTP 500/502/503/504，并且同稳定请求ID的任务状态确认为FAILED时考虑恢复。恢复前必须核对当前授权归属、完整请求指纹、失败token、唯一错误终态，以及终态清单中每次原文的稳定key/SHA/长度/validation。结构解析失败必须有实际失败原文；只有模型尚未返回内容的通用调用失败可以有显式空原文清单。

恢复使用同一body和requestId，等待2.5秒后最多再次请求一次，两次请求共享60秒预算。所有旧失败事实必须原样存在，成功必须使用新的token及其原文。关系实体conversation的普通更新时间不属于原始事实，不纳入不可变比较；归属仍逐次核对。

完整留存的首轮失败无论后续是否恢复，都进入 `qualityFailures` 和独立首轮失败率门槛（低于0.5%）。第二轮仍失败但事实完整时，返回明确未恢复结果，允许继续持续容量取证；最终质量门槛仍不通过。缺记录、记录覆盖或重复、body冲突、未知任务状态、未知错误或失败却产生消息仍属于致命对账错误。主runner既有最终qualityFailures汇总会保留这些失败，不需修改main。

36项Node行为测试和相关ESLint通过，见 single-review-http-recovery-tests.log（本机证据：`single-review-http-recovery-tests.log`）。未以单测替代真实恢复/供应商成功率结论；下一轮40人长时验证由主任务运行。
