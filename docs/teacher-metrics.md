# 教师端指标口径与来源

本清单用于核对教师端已经展示的数字。百分比只在分母大于零且有可信来源时呈现；`—` 表示尚无可统计数据，零表示确实观察到零。显示时才舍入。课堂的“已进入本场”指该场 `ClassroomParticipation`，离线仍计入；教学班人数指当前 `ACTIVE` 或 `COMPLETED` 的 `Enrollment`。

| 指标 | 来源和统计范围 | 算法与去重 | 更新方式 | 核对测试 |
| --- | --- | --- | --- | --- |
| 教学班、已进入、在线人数 | `Enrollment`、本场 `ClassroomParticipation`、presence | 教学班过滤退班；本场按参与者计一次；在线只计当前 presence | 教学班接口、课堂投影、presence 轮询 | `student-records.test.ts`、`ai-learning-timing.test.ts` |
| 资料打开与完成 | 本场参与者、启动资料、学习事件及旧版 `downloadedBy` | 每人每资料取有效事件；完成按完成事件或达到阅读边界；旧下载只代表打开 | 课堂事件刷新投影 | `teacher-dashboard-metrics.test.ts` |
| AI 学习进度与分布 | 本场参与者、与当前课堂场景标识匹配的可信 `StudentAiProgress` | 已完成主课场景数／有效主课场景数；旧场景记录待核验单列；每人只落入一个 10% 区间 | 进度上报后课堂投影刷新 | `teacher-dashboard-metrics.test.ts`、`teacher-presentation-analytics.test.tsx` |
| 小测提交覆盖 | 本场参与者、各节首次有效提交 | 已提交的学生与章节组合／学生数×配置章节数；首次提交按 quiz outline 去重；待批阅仍计提交 | 小测提交后课堂投影刷新 | `knowledge-lecture.test.ts`、`teacher-dashboard-metrics.test.ts` |
| 小测正确率、得分率、章节均分 | 服务端核验并保存的逐题评分 | 客观正确率＝答对客观题／已批阅客观题；得分率＝有效得分／对应满分；章节均分＝该节学生有效得分率的算术平均。待批阅和旧版未核验分数不计 | 评分完成或重试后刷新 | `route.test.ts`、`teacher-dashboard-metrics.test.ts` |
| 知识点未达标率 | 服务端核验评分、知识点映射 | 首次作答中低于 80% 的学生／有效作答学生；学生、题目去重 | 小测评分刷新 | `knowledge-lecture.test.ts` |
| AI 学习时长与速度 | 本场完整 `LearningEvent`，不受最近 10,000 条明细限制 | 幂等键去重，只计可见且有效的心跳时长；预计时长按场景汇总 | 课堂投影刷新 | `ai-learning-timing.test.ts` |
| 成果草稿、定稿、协作 | 本场参与者、作品版本、提交、AI 交互和决策 | 每个状态按学生去重；决策按稳定身份去重 | 课堂投影刷新 | `teacher-dashboard-metrics.test.ts` |
| 汇报就绪、评价完成、预计剩余 | 本场汇报队列及汇报记录 | 按队列成员状态计数；预计剩余以配置时间和已用时估算 | 汇报队列刷新 | `teacher-dashboard-metrics.test.ts` |
| 反思与体验问卷 | 本场反思记录；课程活动问卷取有效成员完成记录 | 每人最新有效记录；体验问卷与反思题集分别统计 | 课堂投影或问卷接口刷新 | `teacher-dashboard-metrics.test.ts`、`survey.test.ts` |
| 前后测提交 | 前测按有效教学班成员；后测按已进入本场者 | 每场、每学生、每阶段唯一正式提交；草稿不算提交；历史退班答卷仍在明细 | 结果接口刷新 | `experiment-service.test.ts` |
| 教学班活动状态 | 活动进度和对应课堂场次参与记录 | 课堂只依据对应活动的参与记录；不能用其他课堂进入记录替代 | 学生记录接口刷新 | `student-records.test.ts` |
| 教材解析阶段估计 | 当前修订版最新 `GenerationJob.progress` | 取最新任务的 0–100 阶段估计，明确标注“约”；不等于学生学习完成率 | 教材列表刷新 | `textbook` 服务及页面测试 |

问卷选项分布以有效提交为来源。单选按答卷人数、多选按选择人次统计，百分比用最大余数法保留一位且合计 100%。已有答卷后锁定题目配置；活动标题、说明和开放状态仍可修改。
问卷提交率按当前有效教学班成员统计，分母为零或人数不一致时不展示百分比；这项指标不等同于某场课堂的参与率。
