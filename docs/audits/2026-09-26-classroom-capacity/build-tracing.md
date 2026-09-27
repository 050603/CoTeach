# Next.js 编译文件追踪与内存异常

日期：2026-09-27。检查人员仅执行只读进程/源码/目录统计及内存中 NFT 探针；没有修改运行代码、读取密钥正文、删除备份或发起 HTTP 压力。根任务随后修改 Next 配置并重试构建。后续新构建已成功，部署结果见文末。

## 已证实的事实

1. Next.js 版本为 **16.2.12**，命令为 `build --webpack`。24GiB heap 构建 worker PID575346 在约710秒时 OOM：最后一次 GC 后仍有24,551MiB存活heap，SIGABRT退出1；之前观察RSS约26.8GiB。日志 `/tmp/openpbl-capacity-reliability-build-24gb.log`，`.next-build/diagnostics/build-diagnostics.json` 标明 `buildStage: compile`，尚未进入TypeScript检查。12GiB前次构建也已失败，继续提高heap并不能解释或修复根因。
2. 项目实际目录体量：`.openpbl-data` 约13GiB；其中 `local-backup` **265,718个文件、约6.7GiB**，`uploads` 513个文件、约2.3GiB；`.openpbl-runtime` 约356GiB；根目录3个core转储合计约20GiB，另有多份旧 `.next-*` 产物。统计只读取文件名及属性，未读取备份/密钥内容。
3. 当前工作区新增npm依赖主要是`three@0.160.0`。未发现证据表明新增事务helper本身引入大型服务端依赖；`prom-client`已列入serverExternalPackages。不能凭修改时间把OOM归因于新业务模块。
4. 限定NFT探针检查了41个非测试的`fs`模块，明确观察到以下拟展开模式：

| 模块 | NFT 模式 |
| --- | --- |
| `src/lib/llm/settings.ts` | `.openpbl-data/**/*`（2次） |
| `src/lib/session/server-store.ts` | `.openpbl-data/**/*`（2次），另有`session.*.*.*.tmp` |
| 上传、成果导出/下载、本地作品、文档归档等模块 | `.openpbl-data/uploads/**/*` |
| `src/lib/realtime/tldraw-sync-server.ts` | `.openpbl-data/whiteboards/**/*` |
| 交互运行时资源路由 | `node_modules/codemirror/**/*`等合法依赖资源目录 |

`audit-outbox.ts`与`classroom-health.ts`的单文件探针没有发出glob。不能把它们当作已定位的触发源。41模块中未观察到项目根`**/*`模式，因此旧发布目录/core文件目前只是潜在放大因素，**不是已证明本次被展开的内容**。

## Next 16 的实际追踪机制

读取本机已安装源码，非推测版本行为：

- `node_modules/next/dist/build/webpack-config.js:1664` 创建 `TraceEntryPointsPlugin`，1671行传入 **`traceIgnores: []`**。
- `.../webpack/plugins/next-trace-entrypoints-plugin.js:317` 将默认忽略、`this.traceIgnores`和`**/node_modules/**`组成matcher；333行调用`nodeFileTrace`，342行使用该matcher作为`ignore`。此入口编译阶段没有把`outputFileTracingExcludes`传入。
- `.../collect-build-traces.js:423` 随后的独立阶段才对路由追踪结果应用`outputFileTracingIncludes/outputFileTracingExcludes`。因此最终输出排除、发布复制过滤不能阻止更早的入口追踪遍历。
- 本机`next/dist/compiled/@vercel/nft/index.js`的`emitAssetDirectory`先计算glob，执行`ignoreFn(relative(base, glob))`，通过后才调用glob递归枚举。故入口traceIgnores匹配`.openpbl-data/**/*`可以在枚举备份前终止它。

该差异解释了为什么原有全局输出排除仍可能让编译阶段扫描运行目录。仅禁用最终复制不足以解决入口追踪成本。

## 只读探针方法

使用本机Next附带的NFT和TypeScript转译器。源文件只读取到内存；自定义`readFile`仅向分析器提供当前模块，所有其他模块返回空字符串。`ignore`记录拟展开glob后立即拒绝，**不实际展开运行目录、不读取任何运行数据正文**。未修改源文件或node_modules。

可复现核心命令：

```sh
node --max-old-space-size=512 <<'JS'
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ts = require('typescript');
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
(async () => {
  const files = cp.execFileSync('rg', [
    '-l', "from ['\"](?:node:)?fs(?:/promises)?['\"]", 'src'
  ], { encoding: 'utf8' }).trim().split('\n').filter(f => !f.includes('.test.'));
  for (const entry of files) {
    const file = path.resolve(entry);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const patterns = [];
    await nodeFileTrace([file], {
      base: process.cwd(), processCwd: process.cwd(),
      readFile: async p => p === file ? source : '',
      ignore: p => { if (p.includes('*')) patterns.push(p); return p !== entry; }
    });
    if (patterns.length) console.log(JSON.stringify({ entry, patterns }));
  }
  console.log('checked ' + files.length + ' fs modules; glob expansion deliberately blocked');
})();
JS
```

该探针证明单文件可产生哪些glob；它不是完整Webpack依赖图或heap profile，不能测出各模块对OOM的精确内存贡献。

## 推断、修复范围和后续判断

**推断：** 两个既有模块产生整个`.openpbl-data`的glob，加上新积累的26.6万备份文件，可能使NFT资产集合、路径缓存和多入口父子依赖映射急剧增长。它与编译阶段巨量存活heap吻合，但没有抓取heap快照，不能宣称已精确证明OOM对象类型或单一因果。

根任务已在`next.config.ts`的生产nodejs webpack钩子中为`TraceEntryPointsPlugin.traceIgnores`加入运行数据、旧发布/构建产物、测试输出、core和密钥目录排除；插件结构不匹配时明确失败，避免Next升级后静默失效。同时保留原输出排除，并启用本机Next文档推荐的`experimental.webpackMemoryOptimizations`及显式`webpackBuildWorker:true`。

这是构建边界修复，无需改变运行时路径、删除备份或关闭审计。由于同时启用了内存优化，后续成功也不能单独量化两项配置各自贡献。

新日志：`/tmp/openpbl-capacity-reliability-build-bounded-trace.log`。需以本轮编译完成、后续检查及产物隔离验证判断修复效果。构建未成功前，继续保留当前健康服务，不开始要求新代码的100样本投屏验收。


## 后续构建与部署结果

采用入口追踪排除及Webpack内存优化后的第三轮构建成功：服务端编译约2.3分钟，全部编译约3.5分钟，TypeScript约104秒，总构建约8分钟。日志末尾确认 `Generated CSS integrity: 25 files passed`，运行产物隔离检查确认没有课堂数据、备份或部署密钥。

根任务已prepare并重启版本 **Ta96tr1OlIteS1dS-6F-y**，健康检查及页面均返回200。前两轮OOM日志继续保留。本轮结果支持构建修复有效，但因同时开启两项配置，仍不单独声称某项配置贡献了全部改善。新版本的100样本HTTP/42WS投屏验收另行记录。
