# @openmaic/renderer

CoTeach 工作区的 React 幻灯片渲染器，读取 `@openmaic/dsl` 的 `Slide`。包提供只读画布、元素、播放视觉效果和浏览器 PNG 快照；课件编辑、课堂权限、媒体存储及教学动作执行由应用管理。

## 画布

```tsx
import { SlideCanvas, type Slide } from '@openmaic/renderer';

export function LessonPage({ slide }: { slide: Slide }) {
  return (
    <div style={{ width: 960, height: 540 }}>
      <SlideCanvas slide={slide} />
    </div>
  );
}
```

父容器必须有有效宽高。画布按 `viewportSize`、`viewportRatio` 和实测容器自动缩放；显式 `scale` 可覆盖自动缩放。`chrome` 默认为 `true`，截图使用 `false` 去除展示壳的阴影与圆角。

| Prop | 行为 |
| --- | --- |
| `slide` | 页面数据；也可由 `SlideRendererProvider` 提供。 |
| `scale`、`background` | 可选缩放与背景覆盖。 |
| `effects` | laser、spotlight、highlight、zoom，默认关闭。 |
| `renderImage`、`renderVideo` | 注入应用媒体呈现，默认使用原生图片与视频。 |
| `onElementClick` | 将元素点击传给调用方。 |
| `className`、`style`、`chrome` | 外层样式与画布展示壳。 |

精确类型以 [SlideCanvas.tsx](src/SlideCanvas.tsx) 和 [effects.ts](src/types/effects.ts) 为准。

## 视觉目标与快照

激光与聚光支持元素 ID 和细粒度 selector，定位文本、表格单元、公式、图中节点或连线时结合当前渲染几何。换行文字可产生多个片段；不能把整个元素矩形当成每个细粒度目标。

播放引擎按讲稿锚点选择当前目标，渲染器呈现当前效果；旧整段 `waypoints` 不由渲染器自行按平均时长播放。生成、语音对齐和动作调度见 [课程生成合同](../../../docs/course-generation.md)。

浏览器快照入口为 `@openmaic/renderer/snapshot` 的 `slideToPng`。导出应等待字体和媒体，并使用无展示壳画布，选项和异常处理见 [snapshot/index.ts](src/snapshot/index.ts)。

## 元素、样式与字体

基础元素从 `@openmaic/renderer/elements` 导出，类型从 `@openmaic/renderer/types` 或主入口导出。Provider 与 `useSlideContext` 用于共享画布上下文，所有数据从调用方传入，不依赖应用全局 Store。

包使用内联几何样式与 [styles.ts](src/styles.ts) 中的独立段落、表格和动画样式，画布自动加载必要规则。Peer 依赖及可选图表/代码库以 [package.json](package.json) 为准。

`@openmaic/renderer/fonts.css` 是可选的外部字体声明，不包含字体二进制。使用该文件时需要相应字体主机可访问；CoTeach 自身的课堂字体、计量和公式资产应保持一致。字体来源及许可保留在 [FONTS.md](FONTS.md)，不能随文档整理删除许可文件。

## 构建与验证

从仓库根执行：

```bash
pnpm --filter @openmaic/dsl build
pnpm --filter @openmaic/renderer build
pnpm --filter @openmaic/renderer typecheck
pnpm --dir packages/@openmaic/renderer exec vitest run
```

包没有单独的 `test` script，测试需显式调用 Vitest。根应用测试不会自动覆盖这些包测试。源码边界见 [DESIGN.md](DESIGN.md)，PPTX 转换见 [importer](../importer/README.md)。包许可为 MIT，字体各自的许可另行保留。
