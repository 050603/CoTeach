# CoTeach 文档导航

这里维护当前系统的使用说明、技术合同和运维入口。功能和命令以实际页面、代码、[数据库 Schema](../prisma/schema.prisma)及 [package.json](../package.json) 为准；历史方案和上线记录通过 Git 查阅。

## 使用与开发

| 文档 | 内容 |
| --- | --- |
| [项目说明](../README.md) | 系统能力、本地启动、目录与常用命令 |
| [教师与学生使用说明](user-guide.md) | 教材、备课、教学班、课堂、项目成果与测评 |
| [系统架构](architecture.md) | 业务边界、接口、协作、实时同步和资源生命周期 |
| [开发与验证工作流](agent-workflow.md) | 按改动选择检查、CI 和提交范围 |
| [设计系统](../DESIGN-SYSTEM.md) | 当前主题、布局、组件与终端适配 |
| [品牌资源](brand.md) | 标识与动画的使用约定 |

## 教学生成与学习

| 文档 | 内容 |
| --- | --- |
| [课程生成与恢复](course-generation.md) | 教材证据、蓝图、原生页面、讲稿、质量诊断和检查点 |
| [个性化学习合同](quality/adaptive-learning.md) | 默认路径与已确认先修、补学、拓展方案的适用边界 |
| [OpenMAIC 集成](openmaic-upstream.md) | 固定包来源及 CoTeach 适配职责 |
| [空间设计参考](slide-spatial-sources.md) | 排版参考来源、依赖与实际适配范围 |
| [教师端指标](teacher-metrics.md) | 人数、进度、测验、成果与问卷的统计口径 |
| [文档 AI 评测案例](ai-collaboration/document-ai-evaluation-cases.md) | 人工标注输入和预期标签 |

## 数据与运维

| 文档 | 内容 |
| --- | --- |
| [数据库设计](database.md) | 当前模型、关系、存储边界与迁移 |
| [研究数据完整性](database/research-integrity.md) | 幂等、留存、删除保护和隔离验证 |
| [研究导出](database/research-export.md) | 导出类型、分页、时间范围与内容权限 |
| [生产部署](../deploy/README.md) | 服务、端口、更新、健康检查与辅助模型 |
| [Secret 配置](../deploy/secrets.example/README.md) | 部署凭据文件与必需变量 |
| [备份与恢复](../deploy/backup/README.md) | 完整恢复点、源码验证和手动精简备份 |
| [课堂容量验收](../tests/load/README.md) | 当前负载工具、真实模型与结果判定 |
| [投屏同步验收](projection-sync-validation.md) | 独立师生浏览器与渲染时延 |
| [多终端布局检查](responsive-layout-checks.md) | 夹具页面、设备范围与实际构建检查 |
| [容量恢复操作](operations/classroom-capacity-restore.md) | 完成某次运行后的备份与隔离恢复 |
| [容量数据清理](operations/classroom-capacity-cleanup.md) | 单个运行的归属核对、dry-run 与清理 |

## 工作区包

- [DSL 契约](../packages/@openmaic/dsl/README.md)
- [生成基础包](../packages/@openmaic/generation/README.md)
- [PPTX 导入器](../packages/@openmaic/importer/README.md)与[维护技能](../packages/@openmaic/importer/SKILL.md)
- [渲染器](../packages/@openmaic/renderer/README.md)与[字体来源](../packages/@openmaic/renderer/FONTS.md)
- [文档解析适配](../src/lib/openmaic/pdf/README.md)
- [应用提示词](../src/lib/openmaic/prompts/README.md)
- [课件编辑 Agent](../src/lib/openmaic/agent/README.md)
- [集成组件翻译维护](../src/lib/openmaic/i18n/TRANSLATION_GUIDE.md)

文档修改应同步入口链接，并核对命令、路由、模型和状态名。提示词模板、技能、许可证与最小回归样例各有独立用途，按实际调用和维护需求保留。
