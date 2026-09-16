# 课程质量对比实验室

这是一个运行在 `3010` 端口的独立实验工具，默认监听 `0.0.0.0`，可从宿主机或内网访问。它只读写
`.openpbl-runtime/course-quality-lab/`，不会创建正式课程、修改正式数据库或占用正式系统端口。

## 生成实验

实验聚焦两个主要应用场景：中小学人工智能通识课与大学《人工智能教育导论》。每个场景生成一次基线／增强对比，共 2 组。每种方案使用相同模型、页面、题量、时长与视觉检查预算；增强方案额外生成小节教学设计，并把它传给 PPT、讲稿和节末题。

```bash
pnpm quality-lab:generate
```

该命令已固定启用工作区 OpenMAIC 包需要的 ESM `import` 条件。

生成器默认以 2 路并发推进方案，降低单个模型服务商出现排队、限流和长尾超时的概率；可用 `--concurrency` 显式调整。生成器同时用单实例锁防止两个进程写入同一批次，并按方案写入检查点，可以重复执行同一命令继续。PPT 与讲稿导出后会先开放查看，再继续生成 TTS；如果刷新生成在新课件可查看前失败，页面会继续保留上一次完整结果并记录失败原因。也可以先生成单组：

```bash
pnpm quality-lab:generate -- --section generative-ai-verification --batch 1
```

补跑失败或缺失的真实 TTS：

```bash
pnpm quality-lab:generate -- --tts-only --retry-failed
```

保持 PPT、题目和授课动作不变，只重新优化增强方案讲稿并生成对应 TTS：

```bash
pnpm quality-lab:generate -- --variant enhanced --narration-only
```

口语化编辑会拦截页面制作术语、资料编号、书面排版符号和过长句，并依据目标时长与讲解段落数控制字数。原段落 ID 和顺序保持不变，确保高亮、指示与讲稿仍然同步。

音频缓存键包含完整讲稿、服务商、模型、音色、语速、语言、格式和地址配置。讲稿或配置变化后不会复用旧音频。浏览器端不会收到服务商密钥。
每个方案同时保存 `input.json`、模型 `calls.json`、`tts-calls.json` 与结果检查点，记录输入指纹、耗时、文本用量、音频字节数和实际解码时长。

## 启动测试页

```bash
pnpm quality-lab:build
pnpm quality-lab:start
```

在宿主机打开 <http://127.0.0.1:3010>，或在同一内网使用 `http://宿主机内网地址:3010`。评判会自动保存到实验目录的 `reviews.json`，页面支持导出 JSON、CSV、PPTX、讲稿和音频包。如需限制监听地址，可设置 `COURSE_QUALITY_LAB_HOST` 或传入 `--host`。

## 验证

```bash
pnpm quality-lab:typecheck
pnpm quality-lab:test
pnpm exec eslint tools/course-quality-lab --max-warnings 0
```
