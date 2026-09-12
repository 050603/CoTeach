# 多终端界面稳定性检查

`scripts/check-desktop-layout.mjs` 使用实际本机页面与浏览器内数据夹具，覆盖首页、师生登录注册、课程列表与详情、教师课程设置弹窗、学生课程返回导航/提醒弹层/账号菜单、个人中心、学生名单及详情、教案库、问卷填写和四类统计图表（含展示模式）。

## 运行

先完成生产构建和本机服务同步，再验证实际运行产物：

```bash
node scripts/check-desktop-layout.mjs --assert
```

默认使用 Chromium，检查 8 个桌面分辨率、平板横竖屏、390/320 像素手机横竖屏。移动设备使用对应的 User-Agent、触控与移动视口配置，每个场景重新访问页面；登录旋转场景还检查横竖切换后学号输入值仍保留。WebKit 可单独运行：

```bash
LAYOUT_BROWSER=webkit LAYOUT_DEVICES=pad-portrait,pad-landscape,phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

可按场景和设备缩小回归范围：

```bash
LAYOUT_SCENARIOS=home,student-login-rotation,teacher-course-dialog LAYOUT_DEVICES=phone-portrait,phone-landscape node scripts/check-desktop-layout.mjs --assert
```

`--source-css` 将工作区平台样式加入页面，只适合构建前检查；上线验收应去掉此参数，确认服务加载的是构建产物。脚本只接受本机地址；可通过 `LAYOUT_BASE_URL` 选择其他本机端口。页面登录门禁使用本机 JWT 密钥签发不存在于数据库的夹具身份，密钥和 Cookie 不进入报告。

## 检测与证据

- 页面横向溢出、关键容器内容溢出、弹窗超出屏幕、文字云裁切、柱图交互宽度。
- 自然长中文标题的宽度和行数、意外文字溢出或被挤成极窄多行；明确配置的省略号和行数截断允许保留。
- 页面 JavaScript 异常、HTTP 失败资源、网络失败、可见图片加载与解码、资源耗时及传输体积。
- 首页和课程夹具使用仓库实际静态图片，图片资源经过应用真实服务加载。

结果持续写入 `/tmp/openpbl-responsive-*/report.json`，末尾生成 `summary.json`；失败场景及主要桌面/移动设备保存截图。`--assert` 在检测失败时返回非零状态。预期可横向滚动的内部容器不等同于页面溢出。

所有业务 API 都在浏览器内拦截：读取返回显式夹具，未定义读取和业务修改被记录并使检查失败；注册邀请码查询作为只读操作返回夹具。脚本不会创建账号、修改课程或提交真实作答。

这套检查验证所列页面、样例内容和浏览器引擎，不替代真实设备软键盘、安全区域、弱网、超大课件及生产数据的专项验收；资源耗时是本机测量值，不作为外网加载性能承诺。

## 内部教学与素材故障验证

```bash
node scripts/check-teaching-layout.mjs --assert
node scripts/check-image-stability.mjs
LAYOUT_BROWSER=webkit node scripts/check-image-stability.mjs
```

内部教学脚本覆盖快速备课、详细备课、课程发布预览、教师授课、学生课堂菜单、代码协作以及真实学生播放器。检查桌面、平板横竖屏、390/320手机横竖屏，包含步骤切换、文件管理、AI组员面板、页面目录收起和课堂菜单；同时检测画布被压扁、正文挤成竖排以及字幕与播放按钮裁切。`TEACHING_DEVICES` 和 `TEACHING_SCENARIOS` 可筛选受影响场景。

素材脚本在桌面和手机上主动模拟封面404、延迟响应和恢复URL，验证替代插画、图片解码以及卡片/封面/正文的位置与尺寸。预期注入的404与意外失败分开记录。图片失败时的替代显示保证页面可读，不代表已恢复远程原文件。

三个脚本均保留严格失败状态，生成本机临时JSON报告与截图；源码样式注入只用于定位问题，最终验证使用实际构建产物。WebKit的设备上下文不固定 `screen`，以便旋转测试同时更新布局屏幕尺寸；保留视口溢出和输入内容保持断言。

WebKit 检查需要浏览器系统依赖。本机本轮使用临时补充的动态库执行页面与图片测试，未将音视频播放和解码计入验证结果。

## 2026-09-12 本轮结果

最终构建 `OcaCDrNJJ5IhgL-OUfP4c` 已通过生产构建和 TypeScript 检查，已重启 `openpbl.service`，3000端口 `/api/health/live` 返回200。相关单元测试、全部本轮修改文件的 ESLint 与差异检查通过。

| 检查 | 结果 | 本机证据目录 |
| --- | --- | --- |
| 8种桌面尺寸的平台基线 | 208项通过 | `/tmp/openpbl-responsive-tLa0wF`（该报告中的2项旧移动失败已在最终移动矩阵复测通过） |
| 最终平台手机/平板横竖屏 | 156/156通过 | `/tmp/openpbl-responsive-fYDXpX` |
| 最终桌面课程导航与弹层 | 1/1通过 | `/tmp/openpbl-responsive-rPkDb5` |
| 最终内部教学七设备、七场景 | 49/49通过 | `/tmp/openpbl-teaching-TYmGiy` |
| 最终WebKit核心页面横竖屏与旋转 | 36/36通过 | `/tmp/openpbl-responsive-6dDsYi` |
| Chromium桌面/手机图片故障、延迟、恢复 | 2/2通过，布局变化0px | `/tmp/openpbl-image-stability-FFxEBk` |
| WebKit桌面/手机图片故障、延迟、恢复 | 2/2通过，布局变化0px | `/tmp/openpbl-image-stability-x03Nu6` |

最终浏览器检查未发现页面运行异常、非预期资源失败或残留破图。以上为所列路由、样例内容和设备模拟检查，不等同于全量生产课件扫描；专业PPT编辑器、外部iframe、真机软键盘和音视频解码未逐项专项验收。
