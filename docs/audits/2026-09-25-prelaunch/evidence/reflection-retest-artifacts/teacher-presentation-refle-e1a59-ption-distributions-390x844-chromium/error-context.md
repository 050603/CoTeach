# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: teacher-presentation.spec.ts >> reflection questions show grounded clouds and per-option distributions 390x844
- Location: e2e/teacher-presentation.spec.ts:308:7

# Error details

```
Error: expect(locator).toBeInViewport() failed

Locator:  getByRole('button', { name: '上一道反思题', exact: true })
Expected: in viewport
Received: viewport ratio 0.988095223903656
Timeout:  5000ms

Call log:
  - Expect "toBeInViewport" with timeout 5000ms
  - waiting for getByRole('button', { name: '上一道反思题', exact: true })
    14 × locator resolved to <button type="button" aria-label="上一道反思题">…</button>
       - unexpected value "viewport ratio 0.988095223903656"

```

```yaml
- button "上一道反思题": 上一题
```

# Test source

```ts
  202 |     : ["退出全屏", "授课展示", "班级学情", "课堂操作", "工具", "教学建议", "结束课堂"];
  203 |   for (const name of controls) {
  204 |     const control = page.getByRole("button", { name, exact: true });
  205 |     await control.scrollIntoViewIfNeeded();
  206 |     await expect(control).toBeInViewport();
  207 |     const box = await control.boundingBox();
  208 |     expect(box?.height, `${name} click target`).toBeGreaterThanOrEqual(40);
  209 |   }
  210 | }
  211 | 
  212 | async function screenshot(page: Page, info: TestInfo, name: string) {
  213 |   const path = info.outputPath(`${name}.png`);
  214 |   await page.screenshot({ path, fullPage: true });
  215 |   await info.attach(name, { path, contentType: "image/png" });
  216 | }
  217 | 
  218 | async function inspectClassroomTools(page: Page) {
  219 |   for (const name of ["学生邀请码", "在线学生"]) {
  220 |     await page.getByRole("button", { name: "工具", exact: true }).click();
  221 |     const tools = page.getByRole("dialog", { name: "课堂工具", exact: true });
  222 |     await expect(tools).toBeVisible();
  223 |     await expect(tools.getByRole("link", { name: "查看课程" })).toHaveAttribute("target", "_blank");
  224 |     await tools.getByRole("button", { name, exact: true }).click();
  225 |     const detail = page.getByRole("dialog", { name, exact: true });
  226 |     await expect(detail).toBeVisible();
  227 |     if (name === "学生邀请码") await expect(detail.getByRole("button", { name: "复制", exact: true })).toBeInViewport({ ratio: 1 });
  228 |     else await expect(detail.getByText("私密学生1", { exact: true })).toBeVisible();
  229 |     await page.keyboard.press("Escape");
  230 |     await expect(page.getByRole("dialog")).toHaveCount(0);
  231 |     await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  232 |   }
  233 |   await page.getByRole("button", { name: "教学建议", exact: true }).click();
  234 |   await expect(page.getByRole("dialog", { name: "教学建议", exact: true })).toBeVisible();
  235 |   await page.keyboard.press("Escape");
  236 |   await expect(page.getByRole("dialog")).toHaveCount(0);
  237 | }
  238 | 
  239 | async function assertWorkspaceFrame(page: Page) {
  240 |   const workspace = page.locator("section.classroom-stage[data-details='true']");
  241 |   await expect(workspace).toBeVisible();
  242 |   const appearance = await workspace.evaluate((node) => {
  243 |     const style = getComputedStyle(node);
  244 |     return { background: style.backgroundColor, border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
  245 |   });
  246 |   expect(appearance.background).toBe("rgba(0, 0, 0, 0)");
  247 |   expect(appearance.border).toEqual(["0px", "0px", "0px", "0px"]);
  248 |   expect(appearance.shadow).toBe("none");
  249 |   const layout = await workspace.evaluate((node: HTMLElement) => {
  250 |     const footer = document.querySelector(".teacher-presentation footer")!;
  251 |     const footerBounds = footer.getBoundingClientRect();
  252 |     let scrollHost: HTMLElement | undefined;
  253 |     for (let candidate: HTMLElement | null = node; candidate; candidate = candidate.parentElement) {
  254 |       const style = getComputedStyle(candidate);
  255 |       if (/(auto|scroll)/.test(style.overflowY) && candidate.scrollHeight > candidate.clientHeight + 1) { scrollHost = candidate; break; }
  256 |     }
  257 |     const bounds = (scrollHost ?? node).getBoundingClientRect();
  258 |     let scrolled = false;
  259 |     if (scrollHost) {
  260 |       const original = scrollHost.scrollTop;
  261 |       scrollHost.scrollTop = scrollHost.scrollHeight;
  262 |       scrolled = scrollHost.scrollTop > 0;
  263 |       scrollHost.scrollTop = original;
  264 |     }
  265 |     return { bottom: bounds.bottom, footerTop: footerBounds.top, needsScroll: Boolean(scrollHost), scrolled };
  266 |   });
  267 |   expect(layout.bottom).toBeLessThanOrEqual(layout.footerTop + 1);
  268 |   if (layout.needsScroll) expect(layout.scrolled).toBe(true);
  269 |   const returnButton = page.locator(".teacher-presentation footer").getByRole("button", { name: "返回展示", exact: true });
  270 |   await expect(returnButton).toBeInViewport({ ratio: 1 });
  271 |   // Real hit testing catches a workspace child painting over the fixed footer.
  272 |   expect(await returnButton.evaluate((node) => {
  273 |     const rect = node.getBoundingClientRect();
  274 |     const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  275 |     return hit === node || node.contains(hit);
  276 |   })).toBe(true);
  277 | }
  278 | 
  279 | async function enterReflection(page: Page) {
  280 |   await enterFullscreen(page);
  281 |   await page.getByRole("combobox", { name: "全屏教学阶段" }).selectOption("4");
  282 |   await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
  283 |   await expect(page.getByRole("region", { name: "反思问卷大屏", exact: true })).toBeVisible();
  284 | }
  285 | 
  286 | async function assertReflectionCloudFits(page: Page) {
  287 |   const canvas = page.getByLabel("词云画布", { exact: true });
  288 |   await canvas.scrollIntoViewIfNeeded();
  289 |   // Fractional CSS pixels at narrow widths can leave a subpixel SVG edge
  290 |   // outside the scrollport. Word bounds below still enforce readable glyphs.
  291 |   await expect(canvas).toBeInViewport({ ratio: 0.995 });
  292 |   const bounds = await canvas.evaluate((node) => {
  293 |     const frame = node.getBoundingClientRect();
  294 |     return { width: frame.width, height: frame.height, clipped: [...node.querySelectorAll("text")].filter((text) => {
  295 |       const word = text.getBoundingClientRect();
  296 |       return word.left < frame.left - 2 || word.right > frame.right + 2 || word.top < frame.top - 2 || word.bottom > frame.bottom + 2;
  297 |     }).map((text) => text.textContent) };
  298 |   });
  299 |   expect(bounds.width).toBeGreaterThan(150);
  300 |   expect(bounds.height).toBeGreaterThan(80);
  301 |   expect(bounds.clipped).toEqual([]);
> 302 |   for (const name of ["上一道反思题", "下一道反思题"]) await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
      |                                                                                                          ^ Error: expect(locator).toBeInViewport() failed
  303 |   await expect(page.getByRole("combobox", { name: "选择反思题目" })).toBeInViewport({ ratio: 1 });
  304 |   await assertNoPageOverflow(page, "reflection");
  305 | }
  306 | 
  307 | for (const viewport of [{ width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
  308 |   test(`reflection questions show grounded clouds and per-option distributions ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
  309 |     await page.setViewportSize(viewport);
  310 |     const fixture = await mockClassroom(page, { reflectionResponses: true });
  311 |     await enterReflection(page);
  312 |     const board = page.getByRole("region", { name: "反思问卷大屏", exact: true });
  313 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection, exact: true })).toBeVisible();
  314 |     const learningTerm = page.getByRole("button", { name: "证据比较，3 人提及", exact: true });
  315 |     await expect(learningTerm).toBeVisible();
  316 |     await expect(page.getByRole("button", { name: /系统导航，/ })).toHaveCount(0);
  317 |     await expect(board).not.toContainText("私密学生");
  318 |     await expect(board).not.toContainText("学习原文");
  319 |     await assertReflectionCloudFits(page);
  320 |     await screenshot(page, info, "reflection-learning-cloud");
  321 |     await learningTerm.click();
  322 |     const evidence = page.getByRole("dialog", { name: "主题“证据比较”的回答 · 3 人", exact: true });
  323 |     await expect(evidence.getByText("私密学生1", { exact: true })).toBeVisible();
  324 |     await expect(evidence).toContainText("学习原文1");
  325 |     await expect(evidence).not.toContainText("系统原文");
  326 |     await page.keyboard.press("Escape");
  327 |     await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
  328 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemReflection, exact: true })).toBeVisible();
  329 |     await expect(page.getByRole("button", { name: "系统导航，2 人提及", exact: true })).toBeVisible();
  330 |     await expect(page.getByRole("button", { name: /证据比较，/ })).toHaveCount(0);
  331 |     await assertReflectionCloudFits(page);
  332 |     await screenshot(page, info, "reflection-system-cloud");
  333 |     await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
  334 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.aiHelpfulness, exact: true })).toBeVisible();
  335 |     await expect(page.getByRole("button", { name: "同意，2 人，67%", exact: true })).toBeVisible();
  336 |     await expect(page.getByRole("button", { name: "非常同意，1 人，33%", exact: true })).toBeVisible();
  337 |     await expect(page.getByRole("button", { name: "非常不同意，0 人，0%", exact: true })).toBeVisible();
  338 |     await expect(board).not.toContainText("私密学生");
  339 |     await screenshot(page, info, "reflection-scale-distribution");
  340 |     await page.getByRole("button", { name: "同意，2 人，67%", exact: true }).click();
  341 |     const selected = page.getByRole("dialog", { name: "选择“同意”的回答 · 2 人", exact: true });
  342 |     await expect(selected).toContainText("私密学生1");
  343 |     await expect(selected).toContainText("私密学生2");
  344 |     await expect(selected).not.toContainText("私密学生3");
  345 |     await page.keyboard.press("Escape");
  346 |     await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("3");
  347 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemUsability, exact: true })).toBeVisible();
  348 |     await expect(page.getByRole("button", { name: "不确定，3 人，100%", exact: true })).toBeVisible();
  349 |     await page.getByRole("button", { name: "题目目录", exact: true }).click();
  350 |     await page.getByRole("navigation", { name: "反思题目目录" }).getByRole("button", { name: new RegExp(REFLECTION_SURVEY_QUESTIONS.reuseIntention) }).click();
  351 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.reuseIntention, exact: true })).toBeVisible();
  352 |     await expect(page.getByRole("button", { name: "非常同意，2 人，67%", exact: true })).toBeVisible();
  353 |     await expect(page.getByRole("button", { name: "下一道反思题", exact: true })).toBeDisabled();
  354 |     await page.getByRole("button", { name: "上一道反思题", exact: true }).click();
  355 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.systemUsability, exact: true })).toBeVisible();
  356 |     await page.getByRole("button", { name: "查看本题回答", exact: true }).click();
  357 |     const allAnswers = page.getByRole("dialog", { name: "本题回答 · 3 人", exact: true });
  358 |     await expect(allAnswers).toContainText("私密学生1");
  359 |     await expect(allAnswers).toContainText("私密学生3");
  360 |     await page.keyboard.press("Escape");
  361 |     await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("0");
  362 |     await expect(board.getByRole("heading", { name: REFLECTION_SURVEY_QUESTIONS.learningReflection, exact: true })).toBeVisible();
  363 |     await expect(page.getByRole("button", { name: "证据比较，3 人提及", exact: true })).toBeVisible();
  364 |     await expect(board).not.toContainText("私密学生");
  365 |     await assertReflectionCloudFits(page);
  366 |     await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  367 |     await expect(page.getByRole("button", { name: "返回展示", exact: true })).toBeVisible();
  368 |     await page.getByRole("button", { name: "返回展示", exact: true }).click();
  369 |     await expect(board).toBeVisible();
  370 |     expect(fixture.course().currentStageIndex).toBe(4);
  371 |     expect(fixture.writes).toHaveLength(1);
  372 |     expect(fixture.writes[0]!.body.action).toMatchObject({ type: "UPDATE_COURSE", payload: { patch: { currentStageIndex: 4 } } });
  373 |     expect(fixture.unexpected).toEqual([]);
  374 |     expect(fixture.errors).toEqual([]);
  375 |   });
  376 | }
  377 | 
  378 | test("empty reflection questions keep all zero choices and never fabricate a cloud", async ({ page }) => {
  379 |   const fixture = await mockClassroom(page);
  380 |   await enterReflection(page);
  381 |   await expect(page.getByText("本题暂未收到回答", { exact: true })).toBeVisible();
  382 |   await expect(page.getByRole("button", { name: "更新词云", exact: true })).toBeDisabled();
  383 |   await expect(page.getByLabel("词云画布", { exact: true })).toHaveCount(0);
  384 |   await page.getByRole("combobox", { name: "选择反思题目" }).selectOption("2");
  385 |   await expect(page.getByRole("button", { name: /，0 人，0%$/ })).toHaveCount(5);
  386 |   await page.getByRole("button", { name: "查看本题回答", exact: true }).click();
  387 |   await expect(page.getByRole("dialog", { name: "本题回答 · 0 人", exact: true })).toContainText("暂无符合条件的回答");
  388 |   expect(fixture.writes).toHaveLength(1);
  389 |   expect(fixture.unexpected).toEqual([]);
  390 |   expect(fixture.errors).toEqual([]);
  391 | });
  392 | 
  393 | test("custom course reflection questions ground each cloud in that question's original answer", async ({ page }) => {
  394 |   await page.setViewportSize({ width: 1920, height: 1080 });
  395 |   const fixture = await mockClassroom(page, { customReflection: true });
  396 |   await enterReflection(page);
  397 |   await expect(page.getByRole("heading", { name: "这次项目中你如何比较证据？", exact: true })).toBeVisible();
  398 |   await expect(page.getByRole("button", { name: "证据比较，3 人提及", exact: true })).toBeVisible();
  399 |   await expect(page.getByRole("button", { name: /系统导航，/ })).toHaveCount(0);
  400 |   await page.getByRole("button", { name: "下一道反思题", exact: true }).click();
  401 |   await expect(page.getByRole("heading", { name: "下一次如何改进你的协作过程？", exact: true })).toBeVisible();
  402 |   await page.getByRole("button", { name: "系统导航，2 人提及", exact: true }).click();
```