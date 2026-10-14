# @openmaic/importer

CoTeach 工作区中的 PPTX 导入器。当前 TypeScript 实现位于 `src/`，解析 OOXML 后输出中间 JSON，或转换为 `@openmaic/dsl` 的可编辑幻灯片。维护规则见 [SKILL.md](SKILL.md)，分层与单位契约见 [DESIGN.md](DESIGN.md)。

## 运行环境与接口

公共浏览器入口包含 DOM、媒体转换和 pdf.js 依赖，应在浏览器中加载。服务器只读 OOXML、测试夹具和结构诊断需使用对应底层入口，不能把公共浏览器 bundle 当作通用 Node.js 解析器。

| 导出 | 输入 / 输出 | 用途 |
| --- | --- | --- |
| `parse(buffer, options?)` | `ArrayBuffer` → `Promise<Output>` | PPTX → 中间 JSON，长度单位为 pt。 |
| `importPptx(input, options?)` | `File / Blob / ArrayBuffer` → `Promise<CanvasSlide[]>` | 解析并转换为 DSL，长度单位为 px。 |
| `parsedToSlides(json, options?)` | `Output` → `Promise<CanvasSlide[]>` | 转换已有中间结果并等待媒体上传结束。 |
| `normalizeImportedSlides(slides)` | `CanvasSlide[]` → `CanvasSlide[]` | 执行 DSL 元素内容规范化，无法规范化的元素记录警告并丢弃。 |
| `configurePdfWorker(url)` | worker URL | 配置媒体转换所用的 pdf.js worker。 |

`parse` 的 `mediaMode` 默认是 `base64`，可显式选择 `blob`。`importPptx` 使用 base64 中间结果，转换器按 `96 / 72` 从 pt 转成 CSS px，并根据原始演示文稿尺寸确定画布比例。

```ts
import { importPptx, parse, parsedToSlides } from '@openmaic/importer';

// 浏览器内预览。
const slides = await importPptx(file);

// 已有中间 JSON 时复用转换层。
const parsed = await parse(await file.arrayBuffer(), { mediaMode: 'base64' });
const converted = await parsedToSlides(parsed);
```

## 媒体持久化

`ImportPptxOptions.upload` 的签名为 `(blob: Blob, filename: string, dir?: string) => Promise<string>`。回调上传到消费方的受权存储并返回可访问的持久 URL，导入器不指定应用上传路由或存储产品。

未配置回调时，图片保留 data URL，音视频可能使用仅当前页面有效的 blob URL。保存课堂前需要核对媒体已持久化。导入会等待上传任务 settle；单个媒体失败可能保留原始图片或不可用媒体，解析成功不能代替资源完整性检查。PPTX 解析失败仍抛出错误。

公开高层入口自动规范化 DSL；直接调用 `transformParsedToSlides` 的消费方需等待 `uploadTasks`，再执行 `normalizeImportedSlides`。字体名称沿用源文稿，实际效果取决于浏览器可用字体；复杂形状、编码和排版的还原限制通过实际样本核对。

## 构建与浏览器产物

从仓库根执行：

```bash
pnpm --filter @openmaic/dsl build
pnpm --filter @openmaic/importer build
node scripts/sync-maic-importer.mjs
```

同步脚本生成 `public/vendor/maic-importer/` 的运行入口，并配置 `public/vendor/pdfjs/` 下的 pdf.js worker。它们是忽略的构建产物，由根 `postinstall` 重建；部署与应用内验证时不能跳过同步。根生产构建命令以 [package.json](../../../package.json) 为准。

需要绕开应用 bundler 时，消费方可从同源 `/vendor/maic-importer/index.js` 动态加载浏览器入口，类型仍从工作区包导入。修改解析源码后，仅更新类型或应用构建不会自动刷新这份独立浏览器产物。

## 分层与验证

依赖方向为 `adapter → serializer → model → parser`。中间数据的字段、单位、继承关系和转换后的 DSL 是不同边界；JSON 错误修复解析与序列化，JSON 正确而画面错误核对渲染器。

```bash
pnpm --dir packages/@openmaic/importer exec vitest run test/<相关测试>.test.ts
pnpm --filter @openmaic/importer test
```

测试和最小输入位于 `test/`。临时 PPTX、解压 XML 与对照 JSON 写入忽略目录，不纳入当前维护文档或提交。
