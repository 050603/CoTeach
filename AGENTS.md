# openPBL / PrAIxis

## 仓库入口

- 应用：`src/app`、`src/components`、`src/lib`；OpenMAIC 集成位于对应的 `openmaic` 子目录。
- 幻灯片契约、解析、渲染：`packages/@openmaic/{dsl,importer,renderer}`。修改导入器时读取 [导入器技能](packages/@openmaic/importer/SKILL.md)。
- 数据库：`prisma`；部署：`deploy/README.md`；UI 约定：`DESIGN-SYSTEM.md`。按任务选择读取。
- Node.js 22、pnpm 10.4.1；命令以 `package.json` 为准。缺依赖时执行 `pnpm install --frozen-lockfile`，保留 postinstall（构建工作区包、同步浏览器解析器并生成 Prisma 客户端）。
- 开发用 `pnpm dev`；生产构建、启动用 `pnpm build` / `pnpm start`，保留仓库对构建与运行目录的隔离。

## 验证

- 应用逻辑：运行受影响的 `pnpm exec vitest run <测试路径>`，类型变更执行 `pnpm typecheck`，代码风格用 `pnpm exec eslint <文件> --max-warnings 0`。
- 根 Vitest 仅覆盖 `src`；子包测试、构建、UI、数据库及 CI 变更按 [开发工作流](docs/agent-workflow.md) 选择检查。
- 新增测试应覆盖行为或回归风险；纯文档改动检查链接与差异即可。失败时先区分本次回归、已有问题和环境缺失，不能把未执行的检查算作通过。

## 本机页面同步

- 当前供用户验收的系统页面由 `openpbl.service` 托管在宿主机 3000 端口。凡修改会影响页面、接口或生产运行产物，完成相关检查后还必须执行 `pnpm build`，构建成功后运行 `systemctl --user restart openpbl.service`，再通过 `http://127.0.0.1:3000/api/health/live` 确认服务恢复；不能仅启动开发端口或告知用户手动刷新来代替部署同步。
- 修改代码运行器时同时构建相关产物并重启 `openpbl-code-runner.service`，验证其配置的 3002 端口；修改 systemd 模板或实际端口时同步更新已安装的用户服务、反向代理和健康检查配置，确保页面入口仍指向本次更新后的实例。
- 构建或健康检查失败时不要声称页面已更新；保留当前可用服务并在结果中说明失败步骤。纯文档、测试或不进入运行产物的工具修改无需重启服务。

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
