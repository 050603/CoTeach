# V2 功能适配与验证（2026-09-08）

本轮沿用 V2 的账号、教学班、模板版本、课堂场次与参与记录结构。旧界面中的 `Course` 只作为应用读取视图，由多个 V2 实体组合；不恢复旧 Course/Teacher/Student 表，不把完整课堂状态塞进模板或 runtimeConfig。

## 页面与持久化边界

| 功能 | V2 数据来源与写入 |
| --- | --- |
| AI 设置 | 身份入口 `/api/auth/me`；ProviderCredential 保存服务配置，密钥加密。设置页不再依赖课堂列表加载，避免旧接口 410 引起“无法读取课堂数据” |
| 完整 PBL 备课 | ClassroomTemplate / ClassroomTemplateVersion；设计字段白名单，发布版本不可覆盖；修改形成草稿，开课绑定已发布版本 |
| 备课生成和恢复 | GenerationJob / GenerationCheckpoint；保留现有生成算法，调整任务和检查点存储 |
| 课堂与五阶段师生页面 | ClassroomInstance / ClassroomParticipation / StageProgress；模板设计来自场次绑定版本，学生身份来自 User + Enrollment；进入具体备课/授课页仅读取该模板/场次，避免载入教师全部班级的课堂数据 |
| 小组、白板、工作计划 | ProjectGroup / GroupMember / GroupBoard / WorkPlanItem；小组归教学班，操作校验实际组成员和对象归属 |
| 公告、待办、资源、上传 | Announcement / AnnouncementReply / Todo / TodoCompletion / Resource / FileAsset；访问校验模板、教学班、参与者范围 |
| AI 对话、协作任务、确认、干预 | AiConversation / AiMessage / AiTask / AiTaskConfirmation / AiSupportRecord / Intervention；保留真实过程记录，失败不伪造模型回答 |
| 阶段提交、反思、评价 | ClassroomSubmission / Reflection / Evaluation；教师评价与学生证据分离，学生不可伪造教师确认 |
| 文档归档、成果与展示 | Artifact / ArtifactVersion / FileAsset / ShowcasePresentation；文档产生真实 DOCX，版本不可覆盖，重复请求不重复归档 |
| 实时状态与历史 | DomainEvent 游标、课堂场次版本；结束课堂保留历史，再开课使用新场次 |
| 普通活动提交 | ActivityProgress 保存当前进度，ActivitySubmission 保存历次提交及活动版本快照 |

扩展 JSON 限定在对应实体内容中：模板 snapshot 存设计；runtimeConfig 存阶段、界面控制和运行版本；submission payload 存单条证据；事件 payload 存一次操作。规范外键、状态和时间仍写入对应列。

## 稳定性与研究留存

- 操作事务、场次级锁、版本冲突和幂等回执防止重复保存及并发覆盖；学生权限依据实际参与关系，包含存量对象、跨组引用和确认状态校验。
- 学习事件、AI 交互与课堂操作保留 researchKey；它是可关联的假名标识，不是完全匿名数据。
- 本轮数据库增量仅为 AiInteractionEvent / DomainEvent 增加 researchKey、查询索引和事实记录外键删除保护，以及 ArtifactVersion 的制品/文件删除保护；未新增业务表。
- 前一轮 ActivitySubmission 与 LearningEvent 的改进参见 [数据库完整性记录](research-integrity.md)。
- 发布模板设计不能通过授课操作静默修改；不支持的修改明确报错。正式实验期间应使用场次绑定的版本。

## 研究导出

教学班教师访问 `/api/platform/offerings/{offeringId}/research-export`。参数 `type=events|submissions|outcomes|ai|domain`，`take` 最大 500，支持 `since`、`until` 和响应中的 `nextCursor`。每页重新校验教学班权限。

默认不导出姓名、用户 ID 和自由文本；`includeContent=true` 才包含事件内容、答案等。导出应持续分页到游标为空。时间窗口固定不等于跨请求数据库快照；正式封存应等待在途写入完成，增量采集重叠窗口并按记录 ID 去重。教师或系统层面事件可能没有 researchKey，应保留其上下文而非强行归到某学生。

## 验证方式

```bash
pnpm typecheck
node scripts/verify-research-database.mjs
OPENPBL_VERIFY_BROWSER=1 node scripts/verify-research-database.mjs
```

数据库脚本只创建带随机标记的独立 PostgreSQL 容器，验证完整迁移链、约束、回填、真实账号与选课事务、五阶段读写、成果展示、AI 任务与确认、文档归档与删除保护，执行后清理。浏览器模式另外使用独立 Next 进程、临时构建目录和测试身份。

本轮未调用付费外部模型进行实际生成，不能把本地接口、任务和持久化验证视为所有模型供应商调用成功。仍需使用实际配置对所选供应商做连接测试。

## 本地迁移记录

当前本地数据库已应用 `20260908150000_v2_classroom_research`。应用前确认只有此增量待执行，并创建、检查了备份：

`/home/lkj/.local/state/openpbl/backups/before-v2-classroom-1788871087827.dump`（0600）

迁移后 User 2、CourseOffering 1、Enrollment 1，数量未变。未部署远端应用，也未重放破坏性的历史 V2 重建迁移。

## 明确退役的旧入口

旧开课设置书签现引导至 V2 教学班安排；已有场次进入所属教学班管理，不再展示清空课堂或重置场次邀请码的旧流程。

旧 `/api/auth/login|register|join` 返回 410，使用 V2 平台账号入口。旧压测数据创建/级联删除 API 在原授权检查后返回 410：它们原先依赖已删除表，不能用来删除 V2 研究事实。课堂验证命令已指向隔离 V2 验证器。旧 JSON 全量导入明确停用，避免重新引入旧库结构；这两项运维入口不属于已恢复的教学功能。

### 已执行检查

- 定向回归 53 个文件、299 项通过，涵盖平台、课堂动作权限、AI/协作、上传、实时通信、研究导出与页面身份加载；另补课堂关闭后排队写入拒绝测试，相关 12 项定向复验通过。
- `pnpm typecheck`、相关文件 ESLint 和 `git diff --check` 通过。
- 独立数据库验证已执行真实五阶段提交/进度、成果展示、AI 任务和 Word 归档。新增发布设计保护与 AI/domain 分页导出扩展后的整套隔离检查也已通过。
- 同一学生跨两个教学班的个人组、真实文件上传与成果展示完整流程已通过独立 PostgreSQL 验证，跨班版本引用被拒绝。

- 浏览器最终通过 12 个场景：AI 设置、备课、教师与学生各五阶段，检查精确阶段内容、预期跳转、刷新与服务端状态。开发冷编译的瞬时错误/超时经新上下文重试通过，保留重试记录；外部模型未配置明确返回 `AI_NOT_CONFIGURED`，不算模型生成验证。

## 3000 生产端口更新（2026-09-08 21:31）

此前源码适配与隔离验证完成时，3000 仍由 systemd `openpbl.service` 运行 19:55 构建的旧版本 `F0DMj5DFPaUk0tM_g3iwd`；真实设置页的课堂与配置请求返回 410。生产服务使用不可变发布目录，源码修改不会自动更新该进程。

现已完成 `pnpm build`，成功后执行 `systemctl --user restart openpbl.service`，确认 3000 运行发布版本 `6enNr_ZC5SJKu58UwDlIC`，健康检查通过。使用现有有效教师身份对 **3000 本身**进行只读浏览器验收：设置页加载和刷新通过，`/api/auth/me`、`/api/server-providers`、`/api/openmaic/provider-config` 均返回 200，不再请求 `/api/courses`，未出现“无法读取课堂数据”及未捕获页面异常。未修改账号或模型配置。已打开旧页面的浏览器需刷新以加载新前端。

### 设置保存状态修复

3000 的实际数据库保存/回读可用，但旧页面在保存后的配置读取失败时，静默忽略读取错误并清空输入框，未记录 `hasApiKey`，导致后续测试提示重新填写密钥。使用独立禁用的测试服务配置及受控读取失败，在更新前复现了该行为；用户现有 DeepSeek 密钥和配置未改变。

保存接口现返回不含密钥的持久化回读结果，页面先更新已保存状态，再清空输入框；配置读取禁止缓存，读取失败明确提示并保留保存回执。页面显示“密钥已保存”。8 项定向测试及生产构建通过，已更新 3000 至 `0YKc3RcI_Mrn4XDhnSqkf`。实际浏览器验证保存后读取失败仍可进入测试请求、无需重填密钥，整页刷新后地址及密钥存在状态保留。连接测试请求被验收脚本拦截，未调用外部模型；独立测试配置已删除，并核对原有 DeepSeek 加密内容和配置保持不变。
