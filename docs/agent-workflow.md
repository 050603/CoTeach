# 开发与验证工作流

本文按任务选用，不要求每个改动执行所有步骤。项目入口见 [AGENTS.md](../AGENTS.md)，命令定义以 [package.json](../package.json) 为准。

## 从目标到交付

定位受影响入口、调用方和已有测试，完成最小但完整的改动，再验证实际行为。复杂任务可保留简短计划；长任务恢复时记录已完成工作、剩余问题与证据，避免重新全量调查。用户补充要求时合并到当前目标中。

仅加载相关技能和参考章节。独立搜索可并行；子代理是否可用由当前运行环境决定，适合委派的是边界清楚的调查或独立实现，共享构建目录和文件编辑避免并发。

## 选择验证范围

以下命令从仓库根执行，路径参数替换为实际受影响文件。

| 改动 | 验证 |
| --- | --- |
| Markdown / 技能 | 检查链接、frontmatter、技能发现路径和 `git diff --check`；不触发应用全量测试 |
| 应用逻辑 | `pnpm exec vitest run <测试路径>`；相关 ESLint；类型影响时 `pnpm typecheck` |
| DSL | `pnpm --filter @openmaic/dsl test`；`pnpm --filter @openmaic/dsl typecheck` |
| 导入器 | `pnpm --filter @openmaic/importer test`；应用内验证前按导入器技能构建并同步浏览器产物 |
| 渲染器 | `pnpm --dir packages/@openmaic/renderer exec vitest run`；`pnpm --filter @openmaic/renderer typecheck` |
| UI / 交互 | 受影响组件测试与实际页面验证；需要端到端覆盖时选 `pnpm exec playwright test <测试路径>`，先读 `playwright.config.ts` 的环境要求 |
| 数据库契约 | `pnpm exec prisma validate`，相关持久化测试；需要迁移时使用隔离的测试数据库，生产操作遵循当前授权及部署文档 |
| 构建 / 依赖 / 跨包边界 | 按依赖顺序构建变化包，执行 `pnpm typecheck`、相关测试及 `pnpm build`；依赖变更增加 `pnpm audit:prod` |
| GitHub Actions | 检查 YAML、表达式、工作区路径及变更命令；具备 actionlint 时使用它，服务端执行结果另行确认 |

根 `pnpm test:ci` 只运行 `src` 测试，根 `pnpm typecheck` 检查应用并消费已构建的包类型；它们不等于全工作区源码验证。子包测试需显式执行。安装的 postinstall 会构建本地包，修改源码后的定向验证不能依赖旧 dist。

## 版本管理与提交

每次实现或测试都在当前任务收尾时检查提交范围；有提交授权时，在提交前完成以下步骤。范围以本次差异为准，保留工作区中其他任务的改动。版本管理边界见 [README](../README.md#版本管理范围)。

1. 开始生成测试或调试产物前选定忽略目录：运行诊断和模型调用产物使用 `.openpbl-runtime/`，临时对照文件使用 `.cache/`，测试与浏览器报告使用 `test-results/`、`playwright-report/` 等已有忽略路径。新产物路径需要时同步补充 `.gitignore`；备份、凭据和真实课堂数据保留在相应本地运行目录。
2. 核对本次每个新增文件的用途与调用方。保留实现、构建、部署恢复和有明确回归价值的测试及最小脱敏样例；一次性实验脚本、重复旧实现、闲置调试代码、报告、截图和导出件在收尾时从本次改动中移除。长期规则更新现有契约或运维文档，过程记录写在交付说明中。
3. 检查工作区差异和已跟踪的忽略文件：

   ```bash
   git status --short
   git diff --stat
   git ls-files -ci --exclude-standard
   ```

   `.gitignore` 不会自动移除已经跟踪的文件；检查命令有输出时，核对归属并修复本次误收录，保留需要的本地数据。文件扩展名和新增行数不能代替用途判断，也不能据此删减必要功能与回归覆盖。
4. 按已审查的文件路径执行 `git add -- <文件路径>`，然后核对暂存区的文件清单和完整内容，确保每一项都服务于当前任务：

   ```bash
   git diff --cached --name-status
   git diff --cached --stat
   git diff --cached --check
   git diff --cached
   ```

5. 完成上表要求的相关验证后再提交。提交说明记录实际行为、检查结果及已有失败或环境限制，不附带另存的过程档案。未获提交授权时完成相同范围检查，交付本次必要差异和验证结果。

## CI 与发布

[共享验证 action](../.github/actions/validate/action.yml) 供 CI 和部署 verify 使用，集中维护环境、安装、Prisma、应用类型、lint、应用及三个 OpenMAIC 子包的测试/类型检查、部署脚本隔离测试与依赖审计。CI 额外构建应用；部署在目标宿主机按已验证 SHA 构建并重启 systemd 服务。保持安装后的包构建与后续检查顺序，避免生成物竞争。

CI 保留完整检查，不用路径跳过掩盖依赖影响；本地验证按上表缩小范围。修复一个失败后只重跑必要检查。发布前核对实际部署入口、环境与当前提交，完整要求见 [部署说明](../deploy/README.md)。

交付说明实现结果、执行过的检查和仍存在的阻塞。不要用结构校验通过代替真实 CI、页面或生产验证。

正式生成的真实模型验收保留在 `tests/course-generation-acceptance`，入口为 `pnpm test:course-generation-acceptance`，类型由 `pnpm typecheck` 检查。默认跳过供应商调用；各测试的显式环境开关见测试入口。执行产物写入已忽略的 `.openpbl-runtime`，不能把未执行的真实模型验收记为通过。
