import { expect, test } from "@playwright/test";

const base = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://127.0.0.1:3000";
const routes = ["/", "/teacher/login", "/teacher/register", "/student/login", "/student/register"];

test("public pages use the concise CoTeach positioning", async ({ page }) => {
  await page.goto(base);
  await expect(page).toHaveTitle("CoTeach｜AI 协同教学平台");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("共同教 · 共同学 · 共同创造");
  await expect(page.getByRole("link", { name: "开始学习" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "每一种智慧，都在课堂中相遇" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI 授课" })).toBeVisible();
  await expect(page.getByText("AI 讲授课程知识，结合小测开展讲解与答疑。").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("项目式学习");

  for (const [route, title] of [
    ["/teacher/login", "教师登录｜CoTeach"],
    ["/teacher/register", "创建教师账号｜CoTeach"],
    ["/student/login", "学生登录｜CoTeach"],
    ["/student/register", "创建学生账号｜CoTeach"],
    ["/student/reset-password", "设置新密码｜CoTeach"],
  ]) {
    await page.goto(`${base}${route}`);
    await expect(page).toHaveTitle(title);
  }
});

for (const route of routes) {
  test(`brand plays automatically without controls on ${route}`, async ({ page }) => {
    await page.goto(`${base}${route}`);
    const logo = page.locator("[data-coteach-animation]").first();
    await expect(logo).toHaveAttribute("data-running", "true");
    await expect(logo.getByRole("img", { name: "CoTeach", exact: true })).toBeVisible();
    await expect(logo.getByRole("button")).toHaveCount(0);
    await expect(logo).toHaveAttribute("data-playback", "once");
    expect(await logo.evaluate((element) => {
      const pages = element.querySelector('[data-coteach-part="pages"]')!.getAnimations()[0];
      const timing = pages.effect!.getTiming();
      const ambient = Array.from(element.querySelectorAll("[data-coteach-ambient]"));
      return timing.duration === 3000
        && timing.iterations === 1
        && ambient.every((node) => node.getAnimations()[0].effect!.getTiming().iterations === Infinity);
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("the login logo remains complete instead of retracting or replaying", async ({ page }) => {
  await page.goto(`${base}/student/login`);
  const logo = page.locator("[data-coteach-animation]");
  await expect(logo).toHaveAttribute("data-running", "true");
  const states = await logo.evaluate((element) => {
    const animations = element.getAnimations({ subtree: true }).filter((animation) => animation.effect!.getTiming().iterations === 1);
    const sample = (time: number) => {
      animations.forEach((animation) => { animation.pause(); animation.currentTime = time; });
      return animations.map((animation) => {
        const target = (animation.effect as KeyframeEffect).target!;
        const style = getComputedStyle(target);
        return { part: target.getAttribute("data-coteach-part"), opacity: Number(style.opacity), transform: Array.from(new DOMMatrix(style.transform).toFloat64Array()) };
      });
    };
    return { complete: sample(3300), later: sample(23800), muchLater: sample(61800), coFirst: sample(2700) };
  });
  const body = (sample: typeof states.complete) => sample.filter((item) => item.part);
  expect(body(states.later)).toEqual(body(states.complete));
  expect(body(states.muchLater)).toEqual(body(states.complete));
  expect(states.coFirst.find((item) => item.part === "word-co")!.opacity).toBeGreaterThan(states.coFirst.find((item) => item.part === "word-teach")!.opacity);
  for (const part of ["pages", "figures", "spark", "word-co", "word-teach", "word-effects"]) {
    expect(states.complete.find((item) => item.part === part)?.opacity).toBe(1);
  }
});

test("paired pages open together, paired figures rise together, then the star appears", async ({ page }) => {
  await page.goto(`${base}/student/login`);
  const logo = page.locator("[data-coteach-animation]");
  await expect(logo).toHaveAttribute("data-running", "true");
  const frames = await logo.evaluate((element) => {
    const sample = (time: number) => {
      element.getAnimations({ subtree: true }).forEach((animation) => {
        animation.pause();
        animation.currentTime = time;
      });
      return Object.fromEntries(["pages", "figures", "spark"].map((part) => [part, Number(getComputedStyle(element.querySelector(`[data-coteach-part="${part}"]`)!).opacity)]));
    };
    return { pages: sample(520), figures: sample(1320), star: sample(2100) };
  });
  expect(frames.pages.pages).toBe(1);
  expect(frames.pages.figures).toBe(0);
  expect(frames.pages.spark).toBe(0);
  expect(frames.figures.figures).toBe(1);
  expect(frames.figures.spark).toBe(0);
  expect(frames.star.spark).toBe(1);
  await expect(logo.locator('[data-coteach-part^="book-"]')).toHaveCount(0);
  const pairsStaySynchronized = await logo.evaluate((element) => {
    return [500, 1200, 1800, 2400, 3100, 4000, 16000, 17100].every((time) => {
      element.getAnimations({ subtree: true }).forEach((animation) => { animation.currentTime = time; });
      return [["pages-left", "pages-right"], ["teacher", "partner"]].every(([left, right]) => {
        const matrix = (part: string) => element.querySelector<SVGGElement>(`[data-coteach-part="${part}"]`)!.getCTM()!.toString();
        return matrix(left) === matrix(right);
      });
    });
  });
  expect(pairsStaySynchronized).toBe(true);
  const wordmarkFits = await logo.evaluate((element) => {
    return [2600, 2670, 2750, 2830, 2920, 3000].every((time) => {
      element.getAnimations({ subtree: true }).forEach((animation) => { animation.currentTime = time; });
      const icon = element.querySelector('[data-coteach-part="lockup"]')!.getBoundingClientRect();
      const co = element.querySelector<SVGGElement>('[data-coteach-part="word-co"]')!;
      const left = new DOMPoint(330, 135).matrixTransform(co.getScreenCTM()!).x;
      return icon.right <= left;
    });
  });
  expect(wordmarkFits).toBe(true);
});

test("mobile forms retain the logo without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const route of routes.slice(1)) {
    await page.goto(`${base}${route}`);
    await expect(page.locator("[data-coteach-animation]")).toBeVisible();
    await expect(page.locator("[data-coteach-animation]")).toHaveAttribute("data-running", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("home hero remains complete while its star and wordmark keep glowing", async ({ page }) => {
  await page.goto(base);
  const hero = page.locator('[data-coteach-animation][data-playback="once"]').first();
  await expect(hero).toHaveAttribute("data-running", "true");
  const samples = await hero.evaluate((element) => {
    const sample = (time: number) => {
      element.getAnimations({ subtree: true }).forEach((animation) => { animation.pause(); animation.currentTime = time; });
      const pose = Array.from(element.querySelectorAll("[data-coteach-part]")).map((node) => {
        const style = getComputedStyle(node);
        return [node.getAttribute("data-coteach-part"), style.opacity, style.transform];
      });
      const light = getComputedStyle(element.querySelector('[data-coteach-ambient="star-light"]')!).opacity;
      const glint = getComputedStyle(element.querySelector('[data-coteach-ambient="word-glint"]')!).transform;
      return { pose, light, glint };
    };
    return [sample(5000), sample(15500), sample(20600), sample(41800)];
  });
  for (const sample of samples) {
    expect(sample.pose).toEqual(samples[0].pose);
    for (const part of ["pages", "figures", "spark", "word-co", "word-teach", "word-effects"]) {
      expect(sample.pose.find(([name]) => name === part)?.[1]).toBe("1");
    }
  }
  expect(new Set(samples.map((sample) => sample.light)).size).toBeGreaterThan(1);
  expect(new Set(samples.map((sample) => sample.glint)).size).toBeGreaterThan(1);

  await hero.evaluate((element) => element.getAnimations({ subtree: true }).forEach((animation) => {
    if (animation.effect!.getTiming().iterations === 1) animation.finish();
    else animation.play();
  }));
  await page.locator(".coteach-origin__word > div").scrollIntoViewIfNeeded();
  await expect(hero).toHaveAttribute("data-running", "false");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(hero).toHaveAttribute("data-running", "true");
  expect(await hero.locator('[data-coteach-part="word-teach"]').evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => hero.locator('[data-coteach-ambient="star-light"]').evaluate((element) => element.getAnimations()[0].playState)).toBe("running");
});

test("home hero replays on refresh and client navigation back to home", async ({ page }) => {
  await page.goto(base);
  const hero = page.locator('[data-coteach-animation][data-playback="once"]').first();
  await expect(hero).toHaveAttribute("data-running", "true");
  await hero.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.effect!.getTiming().iterations === 1).forEach((animation) => animation.finish()));
  await page.reload();
  await expect(hero).toHaveAttribute("data-running", "true");
  const entranceTime = () => hero.locator('[data-coteach-part="pages"]').evaluate((element) => Number(element.getAnimations()[0]?.currentTime ?? Infinity));
  await expect.poll(entranceTime).toBeLessThan(3000);
  await hero.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.effect!.getTiming().iterations === 1).forEach((animation) => animation.finish()));
  await page.getByRole("link", { name: "开始学习", exact: true }).first().click();
  await page.getByRole("link", { name: "返回首页", exact: true }).click();
  await expect(hero).toHaveAttribute("data-running", "true");
  await expect.poll(entranceTime).toBeLessThan(3000);
});

test("reduced motion shows the finished logo without animations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of ["/", "/student/login"]) {
    await page.goto(`${base}${route}`);
    if (route === "/") {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    const logo = page.locator("[data-coteach-animation]").first();
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    for (const part of ["word-co", "word-teach"]) {
      expect(await logo.locator(`[data-coteach-part="${part}"]`).evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    }
  }
});

test("home story starts on entry and pauses outside the viewport", async ({ page }) => {
  await page.goto(base);
  const story = page.locator(".coteach-origin__word > div").first();
  await expect(story).toHaveAttribute("data-playback", "once");
  await expect(story).not.toHaveAttribute("data-started", "true");
  await story.scrollIntoViewIfNeeded();
  await expect(story).toHaveAttribute("data-running", "true");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(story).toHaveAttribute("data-running", "false");
  expect(await story.evaluate((element) => element.getAnimations({ subtree: true }).every((animation) => animation.playState === "paused"))).toBe(true);
});

test("the server-rendered logo stays complete without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${base}/student/login`);
  // Test the component SSR output separately from the route's streamed shell,
  // whose Suspense content can require hydration before it is displayed.
  const markup = await page.evaluate(() => ({
    logo: document.querySelector("[data-coteach-animation]")!.outerHTML,
    styles: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((link) => link.outerHTML).join(""),
  }));
  await page.setContent(`<html><head><base href="${base}/">${markup.styles}</head><body>${markup.logo}</body></html>`);
  const logo = page.locator("[data-coteach-animation]");
  await expect(logo).toBeVisible();
  await expect(logo.locator("[data-coteach-part=word-co] image")).toBeVisible();
  await expect(logo.locator("[data-coteach-part=word-teach] image")).toBeVisible();
  expect(await logo.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
  for (const part of ["pages", "figures", "spark", "word-co", "word-teach"]) {
    expect(await logo.locator(`[data-coteach-part="${part}"]`).evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  }
  await context.close();
});
