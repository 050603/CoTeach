import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { textbookFixture, textbookId, textbookTitle, firstChapter, firstSection, conceptName } from './fixtures/textbook-library';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
test.use({ baseURL });

async function prepare(page: Page, count = 300, failed = false) {
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  test.skip(!secret, 'Provide JWT_SECRET or OPENPBL_E2E_JWT_SECRET_FILE for the acceptance server.');
  const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-textbook', displayName: '教材验收教师' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-textbook-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret!));
  await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(baseURL).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  const payload = textbookFixture(count);
  if (failed) { payload.revision!.status = 'FAILED'; payload.job = { status: 'FAILED', error: '测试解析失败，请重试' }; }
  let searchFailed = false;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/auth/me') return json({ user: { sub: 'e2e-textbook-teacher', role: 'teacher', sv: 1, username: 'e2e-textbook', displayName: '教材验收教师' }, configured: true });
    if (url.pathname === '/api/textbooks') return json({ items: [payload.textbook, { ...payload.textbook, id: 'e2e-other-book', title: '编程与问题求解', author: '课程研究组', updatedAt: '2026-09-20T00:00:00.000Z' }] });
    if (url.pathname === `/api/textbooks/${textbookId}`) return json(payload);
    if (url.pathname.endsWith('/retry')) { payload.revision!.status = 'READY'; payload.job = null; return json({ success: true }); }
    if (url.pathname.endsWith('/search')) {
      if (url.searchParams.get('q') === '检索错误' && !searchFailed) { searchFailed = true; return json({ message: '测试原文检索失败' }, 503); }
      const query = url.searchParams.get('q') || '';
      return json({ query, degraded: false, degradationReason: null, hits: query.includes('原文证据') ? [{ retrievalItemId: 'search-hit-1', content: payload.sourceBlocks![0].content, sectionId: 'section-0', sourceBlockId: 'block-0' }] : [] });
    }
    // Never let acceptance mocks write or read production application data.
    return json({ message: `Acceptance fixture has no route: ${url.pathname}` }, 404);
  });
  return payload;
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (timing && Number.isFinite(timing.endTime)) animation.finish();
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: 'image/png' });
}
async function graphReady(page: Page) {
  await expect(page.locator('[data-graph-ready="true"]')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[role="img"] canvas').first()).toBeVisible();
}
async function openSection(page: Page) {
  await page.getByLabel('教材阅读区').getByRole('button', { name: new RegExp(firstChapter) }).click();
  await page.getByLabel('子章节').getByRole('button', { name: firstSection }).click();
  await expect(page.getByLabel('教材阅读区').getByRole('heading', { name: firstSection })).toBeVisible();
}

test('textbook library → reading → evidence → real graph → fullscreen → keyboard search and history', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await prepare(page); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/teacher/textbooks');
  await expect(page.getByRole('heading', { name: textbookTitle })).toBeVisible();
  await expect(page.getByRole('button', { name: '封面网格' })).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, info, 'library-grid-desktop');
  await page.getByRole('button', { name: '紧凑列表' }).click();
  await page.getByLabel('教材排序').selectOption('title');
  await expect(page.getByRole('article').first()).toContainText('编程与问题求解');
  await page.getByLabel('搜索教材').fill('数字教材研究组');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('link', { name: '查看教材', exact: true }).click();
  await expect(page.getByRole('heading', { name: '从一个章节开始探索' })).toBeVisible();
  await openSection(page);
  await page.getByLabel('本节知识点').getByRole('button', { name: conceptName(0), exact: true }).click();
  const detail = page.getByRole('complementary', { name: '知识点详情' });
  await expect(detail.getByRole('heading', { name: conceptName(0), exact: true })).toBeVisible();
  await screenshot(page, info, 'reading-with-evidence');
  await detail.getByRole('button', { name: '查看原文' }).click();
  await expect(page.locator('#source-block-0')).toHaveAttribute('data-highlighted', 'true');
  await page.getByRole('tab', { name: '知识图谱' }).click(); await graphReady(page);
  await page.getByText('以列表浏览当前节点', { exact: true }).click();
  await page.locator('details[open]').getByRole('button', { name: new RegExp(conceptName(0)) }).click();
  await expect(detail).toBeVisible();
  await page.getByRole('button', { name: '全屏查看图谱' }).click();
  await expect(page.locator('[data-fullscreen="true"]')).toBeVisible();
  await expect(page.locator('[data-fullscreen="true"]').getByRole('complementary', { name: '知识点详情' })).toBeVisible();
  await screenshot(page, info, 'graph-fullscreen-with-evidence');
  await page.getByRole('button', { name: '退出全屏图谱' }).click();
  await expect(page.locator('[data-fullscreen="true"]')).toHaveCount(0);
  await page.getByRole('combobox', { name: '搜索本书' }).fill('原文证据');
  await expect(page.getByRole('listbox', { name: '书内搜索结果' }).getByRole('option')).toHaveCount(1);
  await page.getByRole('combobox', { name: '搜索本书' }).press('ArrowDown');
  await page.getByRole('combobox', { name: '搜索本书' }).press('Enter');
  await expect(page.getByRole('tab', { name: '章节阅读' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#source-block-0')).toHaveAttribute('data-highlighted', 'true');
  await page.goBack();
  await expect(page.getByRole('tab', { name: '知识图谱' })).toHaveAttribute('aria-selected', 'true');
  await expect(detail).toBeVisible(); await graphReady(page);
  await page.reload(); await graphReady(page); await expect(detail).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile directory and evidence drawers; parsing and search failure recovery', async ({ page }, info) => {
  test.setTimeout(90000);
  await prepare(page, 300, true); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/teacher/textbooks/${textbookId}`);
  await expect(page.getByText('测试解析失败，请重试')).toBeVisible();
  await page.getByRole('button', { name: '重新解析', exact: true }).click();
  await expect(page.getByText('测试解析失败，请重试')).toHaveCount(0);
  await page.getByRole('button', { name: '目录', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '教材章节目录' });
  await expect(drawer).toBeVisible(); await screenshot(page, info, 'mobile-directory');
  await drawer.getByRole('button', { name: `展开目录：${firstChapter}` }).click();
  await drawer.getByRole('button', { name: new RegExp(`1.1 ${firstSection}`) }).click();
  await expect(drawer).toHaveCount(0);
  await page.getByLabel('本节知识点').getByRole('button', { name: conceptName(0), exact: true }).click();
  await expect(page.getByRole('dialog', { name: '知识点详情' })).toBeVisible();
  await screenshot(page, info, 'mobile-evidence');
  await page.getByRole('button', { name: '收起知识点详情' }).click();
  await page.getByRole('combobox', { name: '搜索本书' }).fill('检索错误');
  await expect(page.getByText('测试原文检索失败')).toBeVisible();
  await page.getByRole('button', { name: '重试原文检索' }).click();
  await expect(page.getByText('测试原文检索失败')).toHaveCount(0);
  await page.getByRole('combobox', { name: '搜索本书' }).press('Escape');
  await page.getByRole('button', { name: '清空搜索' }).click();
  await page.getByRole('tab', { name: '知识图谱' }).click(); await graphReady(page);
  await page.getByText('以列表浏览当前节点', { exact: true }).click();
  const firstNode = page.locator('details[open]').getByRole('button', { name: conceptName(0), exact: true });
  await firstNode.click();
  const graphDrawer = page.getByRole('dialog', { name: '知识点详情' });
  await expect(graphDrawer).toBeVisible();
  await expect(graphDrawer.getByRole('heading', { name: conceptName(0), exact: true })).toBeVisible();
  await screenshot(page, info, 'mobile-graph-evidence');
  await page.keyboard.press('Escape'); await expect(graphDrawer).toHaveCount(0);
  await page.getByRole('button', { name: '全屏查看图谱' }).click();
  await expect(page.locator('[data-fullscreen="true"]')).toBeVisible();
  await firstNode.click(); await expect(graphDrawer).toBeVisible();
  await expect(page.locator('[data-fullscreen="true"]').getByRole('dialog', { name: '知识点详情' })).toBeVisible();
  await screenshot(page, info, 'mobile-fullscreen-graph-evidence');
  await graphDrawer.getByRole('button', { name: '关闭知识点详情', exact: true }).click();
  await page.getByRole('button', { name: '退出全屏图谱' }).click();
  await expect(page.locator('[data-fullscreen="true"]')).toHaveCount(0);
  await page.getByRole('tab', { name: '章节阅读' }).click();
  const next = page.getByLabel('教材阅读区').getByRole('button', { name: /下一节/ });
  await next.scrollIntoViewIfNeeded();
  await expect(page.getByLabel('教材阅读区').getByRole('heading', { name: firstSection })).not.toBeInViewport();
  await next.click();
  const nextHeading = page.getByLabel('教材阅读区').getByRole('heading', { name: '第2章 教学实践与知识探索', exact: true });
  await expect(nextHeading).toBeInViewport();
  await screenshot(page, info, 'mobile-next-chapter-scroll-reset');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const count of [300, 1000, 3000]) test(`real Canvas performance and bounded graph: ${count} concepts`, async ({ page }, info) => {
  test.setTimeout(90000);
  const payload = await prepare(page, count); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/teacher/textbooks/${textbookId}`);
  await expect(page.getByRole('heading', { name: '从一个章节开始探索' })).toBeVisible();
  const started = performance.now();
  await page.getByRole('tab', { name: '知识图谱' }).click(); await graphReady(page);
  const overviewMs = performance.now() - started;
  await screenshot(page, info, `graph-${count}-overview`);
  await page.getByText('以列表浏览当前节点', { exact: true }).click();
  const localStarted = performance.now();
  await page.locator('details[open]').getByRole('button', { name: new RegExp(firstChapter) }).click();
  await expect(page.getByRole('img', { name: new RegExp(firstChapter) })).toBeVisible(); await graphReady(page);
  const chapterMs = performance.now() - localStarted;
  const nodeCount = Number(await page.locator('[data-graph-ready]').getAttribute('data-visible-node-count'));
  expect(nodeCount).toBeLessThanOrEqual(200); expect(nodeCount).toBeGreaterThan(0);
  await screenshot(page, info, `graph-${count}-chapter`);
  if (count === 3000) { await page.getByRole('button', { name: '更多知识点', exact: true }).click(); await graphReady(page); await expect(page.getByText(/2 \/ 2 · 共 250 个知识点/)).toBeVisible(); }
  await info.attach('performance', { body: JSON.stringify({ concepts: count, relations: payload.relations!.length, overviewMs, chapterMs, visibleConcepts: nodeCount, targets: { overviewMs: 2000, chapterMs: 1000 }, meetsTargets: overviewMs <= 2000 && chapterMs <= 1000 }, null, 2), contentType: 'application/json' });
  // Record targets separately: elapsed browser action time includes Playwright overhead.
  expect(overviewMs).toBeLessThan(15000); expect(chapterMs).toBeLessThan(15000);
});

for (const viewport of [
  { width: 320, height: 568 }, { width: 430, height: 932 },
  { width: 568, height: 320 }, { width: 932, height: 430 },
  { width: 768, height: 1024 }, { width: 820, height: 1180 },
  { width: 1024, height: 576 }, { width: 1024, height: 768 },
  { width: 1180, height: 820 }, { width: 1280, height: 720 },
  { width: 1366, height: 768 }, { width: 1440, height: 900 },
  { width: 1920, height: 1080 }, { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]) test(`reader visual acceptance ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
  await prepare(page); await page.setViewportSize(viewport);
  await page.goto(`/teacher/textbooks/${textbookId}`); await openSection(page);
  await screenshot(page, info, `reader-${viewport.width}x${viewport.height}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('textbook library grid and list fit a 320px mobile screen', async ({ page }, info) => {
  await prepare(page); await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/teacher/textbooks');
  await expect(page.getByRole('heading', { name: textbookTitle })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, info, 'library-grid-320x568');
  await page.getByRole('button', { name: '紧凑列表' }).click();
  await expect(page.getByRole('button', { name: '紧凑列表' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await screenshot(page, info, 'library-list-320x568');
});
