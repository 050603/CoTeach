# GPT-6 Astra 仓库指令与工作流审计

审计日期：2026-09-08。目标是减少无效上下文、失效前置条件与重复流程，提高端到端任务完成质量。未进行模型性能 A/B 测试，不声称可量化的性能增益。

## 范围与依据

检查了根 `AGENTS.md`、`CLAUDE.md`，仓库唯一的 `packages/@openmaic/importer/SKILL.md`，三个 GitHub workflows，以及相关 package scripts、测试配置、导入器源码/测试和部署说明。扫描包含隐藏目录；起始仓库没有 `.agents/skills` 或仓库 `.codex` 配置。运行中工作区出现大量其他修改，保留其内容；后续按用户要求完成 schema 格式与 systemd 部署工作流修订。

应用的教学提示词和历史研究计划保持原样；后续验收修复了部署入口、安全依赖和阻塞 lint 的应用代码。用户后续明确要求全局生效，已更新 `/home/lkj/.codex/AGENTS.md`；未修改模型设置或已安装插件。

官方来源（当天实际读取）：

- [GPT-6 Astra 模型指导](https://developers.openai.com/api/docs/guides/latest-model)：明确自主完成、技能冲突处理、按任务控制测试和委派的建议。
- [AGENTS.md 发现与作用域](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：根指令保持简短，专门知识按作用域组织。
- [Build skills](https://learn.chatgpt.com/docs/build-skills)：name/description 元数据、按需加载、`.agents/skills` 发现路径及目录符号链接支持。
- [Prompting](https://learn.chatgpt.com/docs/prompting)：提供目标、相关上下文与可验证结果。
- [GitHub composite actions](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action)：复用步骤，保留调用 workflow 的 job 结构。

上述是设计依据，下面的路径、命令和具体修复来自本仓库核验。没有把官方示例整段复制成额外全局指令。

## 发现与处置

| 发现 | 处置 |
| --- | --- |
| 根 AGENTS.md 只有 Next.js 提醒，无项目入口、可执行命令和验证边界 | 保留 Next.js 提醒，补充项目入口与验证路由；通用工作约定移至用户级全局 AGENTS.md，避免重复加载 |
| CLAUDE.md 已通过 `@AGENTS.md` 复用根规则 | 保留，避免第二份规则来源 |
| 导入器 SKILL 无 frontmatter，且不在标准发现位置 | 补充明确触发范围，通过 `.agents/skills/maic-importer` 目录符号链接复用原文件，不复制正文 |
| `iterate-prompt.md` 链接失效，`scripts/inspect-low-scores.mjs` 缺失，强制依赖历史评分批次与报告 | 移除普通修复的外部前置条件；仅用户请求并提供数据时进行批量质量迭代 |
| 历史案例要求 grpFill 一律透明，与当前父组继承实现/测试冲突 | 改为区分有无父组填充，保留 noFill、裁剪、组变换等实际易错点 |
| 技能重复 DESIGN 分层表，固定提交语言和逐步操作束缚不相关任务 | 链接现有架构，保留依赖方向和兼容约束；以行为复现和验证结果代替固定仪式 |
| 强制与 `src1` 运行比较 | 保留只读参考，取消每次修复的运行前置条件 |
| 应用通过静态 vendor 加载解析器，旧技能未说明构建同步 | 增加按需构建及 `sync-maic-importer.mjs`，避免验证旧产物 |
| CI 与 deploy verify 重复维护环境和验证命令 | 提取 `.github/actions/validate/action.yml`；CI/部署共用检查，保留手动部署及 environment 边界 |
| CI 使用当前 Prisma 不支持的 `format --check` | 改为临时副本 format 后 diff，并完成 schema 格式化；CI 与部署统一启用 |
| “Type check all workspaces” 与实际应用范围不符；lint 注释声称有 warning baseline | 修正步骤名称和说明，保留零警告命令 |
| 根 Vitest 只包含 src，根 typecheck 不覆盖所有包源码 | 共享 action 显式加入三个 OpenMAIC 子包测试和类型检查；开发工作流保留本地定向检查命令 |
| CodeQL 没有模型提示词或重复行为规则 | 保留现有安全扫描，不为提示词优化变更扫描策略 |

## 全局生效与部署修订

- 用户级文件已写入当前 `CODEX_HOME=/home/lkj/.codex` 的 `AGENTS.md`，不存在同级 override。全局与根指令合计 3249 字节，低于当前 32768 字节限制。当前任务已收到宿主重新注入的新版全局及项目 AGENTS.md，确认实际加载；新运行自动发现。
- 旧部署 workflow 的镜像发布、签名与蓝绿调用属于已移除的容器应用架构。现在由 `deploy/deploy-systemd.sh` 在专用远程 checkout 拉取已验证 SHA，检查工作区和服务路径、安装依赖、构建、重启现有用户服务并检查健康状态。
- 移除不再使用的 registry 写入和 OIDC 权限，保留 GitHub environment 和 SSH 主机校验。不同环境需独立主机或用户，连接配置和服务安装要求见 `deploy/README.md`。
- 部署脚本在构建失败时保留当前运行服务，在健康检查失败时退出，不在数据库迁移后自动回滚。没有连接远程主机、执行生产迁移或重启服务。

## 实际验证

- 技能 quick_validate、发现路径与本地链接检查通过。
- 三个 workflow 和共享 action 的 YAML 解析、shell 语法检查通过；actionlint 本机不可用，未宣称 GitHub 服务端执行通过。
- Prisma validate 与临时副本格式检查均通过。格式化前后忽略空白的 schema diff 仍为已有 423 行新增，保留其他任务的数据结构改动。
- DSL：226 项测试及类型检查通过；导入器：33 项测试及类型检查通过；渲染器：2 项测试及类型检查通过。
- 部署脚本：6 项隔离测试通过，覆盖成功更新、脏工作区、构建失败、健康失败、并发锁和非法提交参数；不操作实际 Git 远端或 systemd 服务。
- 应用全量复测：261 个文件、1209 项测试通过；随后新增焦点导航回归用例所在文件单独复测，8 项通过（包含 1 项新增测试）。合计覆盖 1477 个不同测试用例，不重复计算单独复测的已有用例。
- `pnpm typecheck`、`pnpm lint:ci` 通过，保留零警告门禁。
- `pnpm build` 完成编译、TypeScript、35 个静态页面生成与构建追踪，产物位于 `.next-build`。
- `pnpm audit:prod` 从 16 项漏洞（10 high、6 moderate）降至 0 项已知漏洞。依赖安装保留 postinstall，并完成工作区包重建、浏览器产物同步及 Prisma Client 生成。
- Prisma 临时显式配置加载并 validate 通过，覆盖 deepmerge-ts 升级影响的配置加载路径。
- 未执行真实 Provider、远程 GitHub CI、生产迁移或服务重启；本地门禁通过不等于生产验收。

## 完整验收补充修复

- 用具体 Slate/React 类型替换编辑器适配中的 `any`，缩小 BlockSelection 的 props 到实际消费的 plugin key，并为节点包装组件命名。
- 教师仪表盘焦点变化时才同步本地选择；普通课程刷新不会反复覆盖用户标签选择。DOM 滚动仍在 effect 中并清理计时器，资源事件回调使用稳定依赖。
- 修复 Next.js 保留变量名和未使用绑定。静态文档图片保留原生 img，局部注明 DOCX 导出用途；未关闭全局 lint 规则。
- 安全修复通过受影响版本范围的 overrides 限定到 js-yaml、nanoid、fast-uri、browserslist、qs、xmldom；deepmerge-ts 8.0.0 仅作用于现有 `@prisma/config@6.19.3`，避免无关依赖跨主版本升级。其 Map 合并行为变化已核对发布说明；当前 Prisma 配置加载检查通过。
- 安全依据：[deepmerge-ts 公告](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)、[8.0.0 发布说明](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)、[js-yaml](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj)、[nanoid](https://github.com/advisories/GHSA-2v37-7h3g-55p8)、[fast-uri](https://github.com/advisories/GHSA-jqff-g426-hqxp)、[browserslist](https://github.com/advisories/GHSA-c83g-rgw3-j3cx)、[xmldom](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6)、[qs](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)。

## 后续效果验证

选择相同仓库快照上的小修复、跨包导入问题和长任务各一例，用相同 Astra 模型与运行环境比较旧/新指令：记录任务成功率、无必要提问、重复检查次数、耗时和 token 用量。先看正确完成率，再看成本；出现真实误判时只调整对应规则。

本次没有修改应用模型路由或个人模型设置，也没有把最高 reasoning effort、最大上下文或固定子代理数量写成通用要求。Markdown 指令不能代替宿主工具、权限与模型配置；全局与项目指令按 Codex 发现机制共同生效。
