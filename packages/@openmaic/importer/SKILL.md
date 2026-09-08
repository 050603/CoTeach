---
name: maic-importer
description: 修复或扩展 openPBL 的 PPTX 导入、OOXML 解析及导入还原质量。适用于 packages/@openmaic/importer；纯 UI 或仅渲染器修改无需加载。
---

# PPTX 导入器维护

目标是修复输入到 JSON 的真实差异，并保持下游兼容。以下路径相对本包目录；从仓库根执行命令时使用 `pnpm --dir packages/@openmaic/importer`。

## 定位与实现

- 分层或跨模块修改先读 [DESIGN.md](DESIGN.md) 对应章节。依赖方向为 `adapter → serializer → model → parser`；模型层不解析视觉样式。复用 `parser/units.ts`、`SafeXmlNode` 和 `utils/color.ts`。
- 先用现有测试或用户样本复现。JSON 数值/样式错误查 serializer 与 RenderContext，节点类型查 model；JSON 正确但画面错误查相邻 renderer 包。master/layout 装饰需同时检查 `layoutElements` 和 `elements`。
- 对实际解析问题，可在本包执行 `node scripts/extract-pptx-structure.js <样本.pptx> <临时目录>` 查看 XML，以及 `pnpm exec tsx scripts/transvert.ts <样本.pptx> <输出.json>` 对比修改前后 JSON。已有最小回归用例足够时无需重复解压整份 PPTX。
- `src1/` 是只读历史参考；仅在新实现行为难以解释时对照，不作为每次修复的运行或构建前置条件。

## 协议与易错点

- `src/adapter/types.ts` 是下游协议：默认保持已有字段名称、类型和可选性；兼容扩展使用可选字段并写明语义。任务明确要求破坏性变更时同步调用方与迁移说明。长度 pt、颜色 `#RRGGBB`、角度 deg；透明值沿用现有协议。
- 保持单位工具签名兼容；新增单位优先新增函数。内部重构遵循上述分层。
- `grpFill` 根据父组上下文解析：存在父组填充时保留继承，无父组填充时不回退到 `fillRef`。以 `test/shapeSerializer.grpFill.test.ts` 覆盖两种情况，避免把历史 Logo 案例推广成“一律透明”。
- 显式 `ln/noFill` 优先于 `lnRef`。图片裁剪同时考虑 `custGeom` 与 `prstGeom`。
- 调整组坐标时覆盖 chOff/chExt、flip 和 rotation 的组合；修改共享 preset 辅助函数时检查受影响调用方。渲染顺序为 layout/master 装饰在前、slide 元素在后。

## 验证与交付

- 本包定向测试：`pnpm exec vitest run test/<相关测试>.test.ts`；跨解析模块修改运行 `pnpm test`。只为有实际回归风险的行为增加测试。
- 验证应用内导入前，从仓库根执行 `pnpm --filter @openmaic/importer build`，再执行 `node scripts/sync-maic-importer.mjs`，使浏览器使用新产物；仅测源码无需构建。DSL 变化时先构建 DSL。
- 临时 PPTX/XML/JSON 放在临时目录，交付前检查差异，避免混入生成物。
- 只有用户请求批量还原质量迭代且提供比较数据时才按批次记录结果；缺少外部评分系统不阻塞本地修复。交付说明样本或回归用例、修复层、检查结果及协议影响。
