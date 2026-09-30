# CoTeach

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

## 课程生成修复约定

- 生成报错先核对失败阶段、已保存草稿、教材原文及实际采用的证据，修复现有优化中的根因；不得通过撤掉优化、跳过门禁、删减应教内容或降低模型与输出预算来掩盖失败。
- PPT 和讲稿分别直接依据实际采用的原始资料生成：页面可准确提炼核心要点，不强制教材定义逐字上屏；讲稿维持既有授课风格、推理和案例，只对关键概念、严谨定义及必要条件采用权威描述，不从 PPT 短句反向创造定义，也不照读整段教材。保留完整事实、数量、边界与真实关系，容量计量以实际展示的要点和必需视觉材料为准。
- 保留已完成阶段、确认过的知识归属与教学顺序、有效案例和教材图片；对未完成阶段做有范围的修复，失败补丁不得覆盖较好的草稿，也不得触发整门课程重写。
- 教材列表按实际采用的证据和编号层次绑定，多个列表分别核对；保持完整事实与真实流程顺序、各来源主题的教学要求覆盖、图示可读性、讲授与检测对齐等已有质量要求。
- 蓝图验收与大纲编译共用页面实际拥有的解释节点、可见内容和讲稿投影；未进入执行页面的单元正文或证据引用不能代替完整授课。生成、教师确认、检查点复用及课堂交接保持同一份质量合同。
- 顺序、循环与分支按实际教学关系表达；不得为适配渲染器删掉分支、虚构相邻步骤或丢弃已有节点。局部修复只有在未新增质量问题且已减少原有问题时才可替换已保存草稿。
- 续跑须回到失败的源头阶段做局部修复，不得反复排队同一份不可执行的大纲。恢复交接以任务版本、请求身份和当前确认来源守护，保留已完成页面、阶段与媒体，并用各自指纹判断能否复用。
- 页面容量预检、原生编译与实际渲染使用一致的字体和图文计量；失败占位值不能代替可行布局。明确的容量过载须进入有界的小节重规划并保存诊断，锁定已验收页面和阶段，守恒小节时长；并列独立流程保留各自完整顺序，不虚构跨流程连接。
- 修改生成链路时运行受影响的既有质量和恢复回归测试；有真实失败快照时可用 [蓝图只读重放](scripts/verify-course-design-recovery.ts) 或 [页面只读重放](scripts/verify-course-page-generation.ts) 验证同一输入。结构检查和真实模型验证分别报告，不把降低报错率等同于课程质量已经通过。

## 本机页面同步

- 当前供用户验收的系统页面由 `openpbl.service` 托管在宿主机 3000 端口。凡修改会影响页面、接口或生产运行产物，完成相关检查后还必须执行 `pnpm build`，构建成功后运行 `systemctl --user restart openpbl.service`，再通过 `http://127.0.0.1:3000/api/health/live` 确认服务恢复；不能仅启动开发端口或告知用户手动刷新来代替部署同步。
- 修改代码运行器时同时构建相关产物并重启 `openpbl-code-runner.service`，验证其配置的 3002 端口；修改 systemd 模板或实际端口时同步更新已安装的用户服务、反向代理和健康检查配置，确保页面入口仍指向本次更新后的实例。
- 构建或健康检查失败时不要声称页面已更新；保留当前可用服务并在结果中说明失败步骤。纯文档、测试或不进入运行产物的工具修改无需重启服务。

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
