// Isolated, sequential prelaunch smoke test. Never reads the deployed DATABASE_URL.
// Run after dependencies are installed: node scripts/verify-prelaunch-functional.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.PRELAUNCH_OUTPUT_DIR || path.join(root, 'test-results/prelaunch/functional'));
mkdirSync(output, { recursive: true });
const container = `openpbl-prelaunch-${randomUUID()}`;
const redisContainer = `${container}-redis`;
const temporary = path.join(tmpdir(), container);
mkdirSync(temporary, { recursive: true });
const distDir = process.env.PRELAUNCH_DIST_DIR || `.next-prelaunch-${process.pid}`;
const port = 3198;
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(18).toString('base64url');
const env = {
  ...process.env,
  DATABASE_URL: '',
  PROVIDER_CONFIG_DATABASE_URL: '',
  PROVIDER_CONFIG_ENCRYPTION_KEY: '',
  REDIS_URL: '',
  PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  INTERNAL_MONITOR_TOKEN: randomBytes(32).toString('base64url'),
  TRUST_PROXY_HEADERS: 'true',
  ENABLE_LOAD_TEST_API: 'false',
  JWT_SECRET: randomBytes(48).toString('base64url'),
  NEXT_DIST_DIR: distDir,
  NEXT_PUBLIC_OPENPBL_SYSTEM_MODE: 'new',
  ENABLE_WEBSOCKET: 'false',
  ENABLE_TLDRAW_SYNC: 'false',
  COURSE_GENERATION_BACKGROUND_ENABLED: 'false',
  UPLOAD_DIR: path.join(temporary, 'uploads'),
  WHITEBOARD_DATA_DIR: path.join(temporary, 'whiteboards'),
  CLASSROOM_DATA_DIR: path.join(temporary, 'classrooms'),
  PUBLIC_BASE_URL: origin,
  NEXT_TELEMETRY_DISABLED: '1',
};
let started = false;
let redisStarted = false;
let server;
let browser;
let db;
let serverOutput = '';
const results = [];
const record = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`${status} ${name}${detail ? `: ${detail}` : ''}`); };
const command = (bin, args, options = {}) => execFileSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000, ...options }).trim();
const report = () => writeFileSync(path.join(output, 'report.json'), JSON.stringify({
  date: new Date().toISOString(), commit: command('git', ['rev-parse', '--short', 'HEAD']),
  mode: 'isolated-production-build-and-disposable-database', browser: browser?.version() ?? null, results,
}, null, 2));

async function checkedRequest(context, method, url, data, expected = 200) {
  const response = await context.request.fetch(`${origin}${url}`, {
    method, headers: { Origin: origin }, ...(data === undefined ? {} : { data }), timeout: 30_000,
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status(), expected, `${method} ${url}: ${response.status()} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function pageCheck(context, name, route, expected, expectedApiErrors = []) {
  const page = await context.newPage();
  const pageErrors = [];
  const resources = [];
  const apiErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400 && /\.(?:js|css|woff2?|png|jpe?g|webp)(?:\?|$)/.test(response.url())) resources.push(`${response.status()} ${new URL(response.url()).pathname}`);
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
      const actual = `${response.status()} ${new URL(response.url()).pathname}`;
      if (!expectedApiErrors.some((allowed) => allowed.test(actual))) apiErrors.push(actual);
    }
  });
  try {
    const response = await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    assert.equal(response?.status(), 200, `${route} returned ${response?.status()}`);
    await page.getByText(expected).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    assert.equal(new URL(page.url()).pathname, route.split('?')[0], 'unexpected redirect');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByText(expected).filter({ visible: true }).first().waitFor({ timeout: 30_000 });
    assert.deepEqual(pageErrors, [], 'uncaught browser error');
    assert.deepEqual(resources, [], 'broken static resource');
    assert.deepEqual(apiErrors, [], 'unexpected API response');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 2, `horizontal overflow ${overflow}px`);
    record(name, '通过');
  } catch (error) {
    const shot = path.join(output, `${name.replaceAll('/', '-')}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    record(name, '失败', String(error.message).slice(0, 350));
  } finally { await page.close(); }
}

async function checkConfiguredProviders(teacher) {
  const sections = (process.env.PRELAUNCH_PROVIDER_SECTIONS || 'providers,tts,asr,pdf,image,video,web-search,embedding').split(',');
  let speechSample;
  for (const section of sections) {
    try {
      const configuration = await checkedRequest(teacher, 'GET', `/api/openmaic/provider-config?section=${section}`);
      const candidate = Object.entries(configuration.providers || {}).find(([id, item]) =>
        item.enabled !== false && (item.hasApiKey || section === 'pdf' || id === 'ollama-embedding'));
      if (!candidate) { record(`provider-${section}`, '阻塞', '未发现已启用且可用的服务配置'); continue; }
      const [providerId, config] = candidate;
      const model = config.defaultModel || config.models?.[0];
      let endpoint = '/api/openmaic/test-provider';
      let data = { section, providerId, ...(model ? { model } : {}) };
      if (section === 'providers') {
        endpoint = '/api/openmaic/verify-model';
        assert.ok(model, '语言模型缺少可测试的模型 ID');
        data = { model: `${providerId}:${model}` };
      } else if (section === 'tts') {
        endpoint = '/api/openmaic/generate/tts';
        const voice = config.defaultVoice || config.scenarioConfigs?.['realtime-interaction']?.voiceId;
        assert.ok(voice, '语音合成缺少默认音色');
        data = { audioId: randomUUID(), text: '上线验收。', ttsProviderId: providerId, ttsVoice: voice, ttsModelId: model };
      }
      const response = section === 'asr' && speechSample
        ? await teacher.request.post(`${origin}/api/openmaic/transcription`, {
          multipart: {
            audio: { name: `prelaunch.${speechSample.extension}`, mimeType: speechSample.mimeType, buffer: speechSample.buffer },
            providerId,
            ...(model ? { modelId: model } : {}),
            language: 'zh',
          },
          headers: { Origin: origin }, timeout: 90_000,
        })
        : await teacher.request.post(`${origin}${endpoint}`, { data, headers: { Origin: origin }, timeout: 90_000 });
      const result = await response.json().catch(() => ({}));
      assert.ok(response.ok(), `${response.status()} ${JSON.stringify(result).slice(0, 180)}`);
      if (section === 'tts') {
        const buffer = Buffer.from(result.base64 || result.data?.base64 || '', 'base64');
        assert.ok(buffer.length > 500, '语音服务未返回可播放音频');
        const format = String(result.format || result.data?.format || 'wav').toLowerCase();
        const extension = format === 'mp3' ? 'mp3' : format === 'ogg' ? 'ogg' : 'wav';
        speechSample = { buffer, extension, mimeType: extension === 'mp3' ? 'audio/mpeg' : `audio/${extension}` };
      }
      if (section === 'asr' && speechSample) assert.ok(result.text || result.data?.text, '真实语音未获得识别文本');
      if (section === 'image') assert.ok(result.previewUrl || result.data?.previewUrl, '图像服务未返回图片');
      if (section === 'providers') assert.ok(result.response || result.data?.response, '语言模型未返回文字');
      record(`provider-${section}`, '通过', `${providerId} 实际请求成功`);
    } catch (error) {
      record(`provider-${section}`, '失败', String(error.message).slice(0, 250));
    }
  }
}

try {
  command('docker', ['run', '--detach', '--rm', '--name', container,
    '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw',
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', 'pgvector/pgvector:0.8.6-pg16']);
  started = true;
  for (let i = 0; i < 60; i++) {
    try { command('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], { timeout: 3000 }); break; }
    catch { if (i === 59) throw new Error('Disposable database did not become ready'); await delay(500); }
  }
  const address = command('docker', ['port', container, '5432/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  env.DATABASE_URL = `postgresql://postgres@${address}/postgres?schema=public`;
  command('node', ['scripts/run-prisma.mjs', 'migrate', 'deploy']);
  db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  await db.$queryRaw`SELECT 1`;
  record('isolated-database-migration', '通过');
  command('docker', ['run', '--detach', '--rm', '--name', redisContainer,
    '--publish', '127.0.0.1::6379', 'redis:7.4.5-alpine']);
  redisStarted = true;
  for (let i = 0; i < 30; i++) {
    try { if (command('docker', ['exec', redisContainer, 'redis-cli', 'ping']) === 'PONG') break; }
    catch { if (i === 29) throw new Error('Disposable Redis did not become ready'); await delay(300); }
  }
  env.REDIS_URL = `redis://${command('docker', ['port', redisContainer, '6379/tcp'])}/0`;
  record('isolated-redis-start', '通过');
  if (process.env.PRELAUNCH_REAL_PROVIDERS === '1') {
    env.PROVIDER_CONFIG_DATABASE_URL = readFileSync(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8').trim();
    env.PROVIDER_CONFIG_ENCRYPTION_KEY = readFileSync(path.join(root, 'deploy/secrets/provider_encryption_key.txt'), 'utf8').trim();
    env.PROVIDER_ENCRYPTION_KEY = env.PROVIDER_CONFIG_ENCRYPTION_KEY;
    env.OPENPBL_OUTBOUND_PROXY = 'http://127.0.0.1:19999';
  }

  if (process.env.PRELAUNCH_REUSE_BUILD !== '1') {
    command('node', ['scripts/run-next-production.mjs', 'build', '--webpack'], { timeout: 1_200_000, stdio: 'pipe' });
    record('isolated-production-build', '通过');
  } else {
    readFileSync(path.join(root, distDir, 'BUILD_ID'), 'utf8');
    record('isolated-production-build', '通过', '复用本次验收构建');
  }
  command('node', ['scripts/check-generated-css.mjs']);
  record('isolated-generated-css-integrity', '通过');
  const standalone = path.join(root, distDir, 'standalone');
  cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true, force: true });
  cpSync(path.join(root, distDir, 'static'), path.join(standalone, distDir, 'static'), { recursive: true, force: true });
  server = spawn(process.execPath, [path.join(standalone, 'server.js')],
    { cwd: root, env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-12000); });
  let ready = false;
  for (let i = 0; i < 180; i++) {
    if (server.exitCode !== null) throw new Error(`Isolated app exited ${server.exitCode}`);
    try { const response = await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1500) }); if (response.ok) { ready = true; break; } }
    catch { /* still starting */ }
    await delay(1000);
  }
  assert.ok(ready, 'Isolated app did not start');
  record('isolated-app-start', '通过');
  browser = await chromium.launch();
  const teacher = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const student = await browser.newContext({ viewport: { width: 1366, height: 768 } });

  await checkedRequest(teacher, 'POST', '/api/platform/auth/teacher-register', {
    username: 'prelaunch-teacher', displayName: '上线验收教师', password, confirmPassword: password,
  }, 201);
  record('teacher-register-real-login-cookie', '通过');
  if (process.env.PRELAUNCH_REAL_PROVIDERS === '1' && process.env.PRELAUNCH_SKIP_PROVIDER_CHECK !== '1') await checkConfiguredProviders(teacher);
  const textbookZip = new JSZip();
  textbookZip.file('docProps/core.xml', '<cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:title>上线验收教材</dc:title><dc:creator>验收教师</dc:creator></cp:coreProperties>');
  textbookZip.file('word/styles.xml', '<w:styles xmlns:w="urn:w"><w:style w:type="paragraph" w:styleId="h"><w:name w:val="heading 1"/><w:outlineLvl w:val="0"/></w:style><w:style w:type="paragraph" w:styleId="h2"><w:name w:val="heading 2"/><w:outlineLvl w:val="1"/></w:style><w:style w:type="paragraph" w:styleId="h3"><w:name w:val="heading 3"/><w:outlineLvl w:val="2"/></w:style></w:styles>');
  textbookZip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="h"/></w:pPr><w:r><w:t>第一章 社区生态调查</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="h2"/></w:pPr><w:r><w:t>第一节 观察与行动</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="h3"/></w:pPr><w:r><w:t>一、社区生态证据</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>观察社区树木与鸟类，记录环境变化并形成有证据支持的行动方案。</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="h3"/></w:pPr><w:r><w:t>二、行动方案方法</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>比较两处绿地的物种记录，例如按观察日期统计鸟类数量。</w:t></w:r></w:p>'
    + '</w:body></w:document>');
  const textbookBytes = await textbookZip.generateAsync({ type: 'nodebuffer' });
  const textbookUpload = await teacher.request.post(`${origin}/api/textbooks`, {
    multipart: { file: { name: 'prelaunch.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: textbookBytes }, title: '上线验收教材' },
    headers: { Origin: origin }, timeout: 90_000,
  });
  const textbookUploadBody = await textbookUpload.json();
  assert.equal(textbookUpload.status(), 201, `textbook upload: ${JSON.stringify(textbookUploadBody).slice(0, 300)}`);
  const textbook = textbookUploadBody.textbook;
  assert.ok(textbook?.id);
  let textbookDetails;
  for (let i = 0; i < 50; i++) {
    textbookDetails = await checkedRequest(teacher, 'GET', `/api/textbooks/${textbook.id}`);
    if (textbookDetails.sections?.length && textbookDetails.sourceBlocks?.length && textbookDetails.concepts?.length) break;
    await delay(500);
  }
  assert.ok(textbookDetails?.sections?.length && textbookDetails?.sourceBlocks?.length, '教材解析未保存章节和正文');
  assert.equal(textbookDetails.concepts.length, 2, '教材二级标题未生成知识点');
  assert.ok(textbookDetails.concepts.some((concept) => concept.name === '社区生态证据' && concept.evidence?.some((item) => item.quote.includes('社区树木'))), '知识点缺少原文证据');
  assert.ok(textbookDetails.relations?.length, '教材知识点未生成关系');
  const textbookSearch = await checkedRequest(teacher, 'GET', `/api/textbooks/${textbook.id}/search?q=${encodeURIComponent('社区树木')}`);
  assert.ok(textbookSearch.hits?.length, '教材关键词检索未返回已解析正文');
  record('textbook-docx-upload-parse-search-persistence', '通过');
  await pageCheck(teacher, 'teacher/textbook-reader', `/teacher/textbooks/${textbook.id}`, '社区生态调查');
  try {
    const graphPage = await teacher.newPage();
    await graphPage.goto(`${origin}/teacher/textbooks/${textbook.id}?view=graph`, { waitUntil: 'domcontentloaded' });
    const graph = graphPage.locator('[data-graph-ready]');
    await graph.waitFor({ timeout: 30_000 });
    await graphPage.waitForFunction(() => document.querySelector('[data-graph-ready]')?.getAttribute('data-graph-ready') === 'true', null, { timeout: 30_000 });
    const firstChapter = textbookDetails.sections.find((section) => section.kind === 'CHAPTER');
    assert.ok(firstChapter?.id);
    await graphPage.goto(`${origin}/teacher/textbooks/${textbook.id}?view=graph&section=${encodeURIComponent(firstChapter.id)}`, { waitUntil: 'domcontentloaded' });
    await graphPage.waitForFunction(() => {
      const graph = document.querySelector('[data-graph-ready]');
      return graph?.getAttribute('data-graph-ready') === 'true' && Number(graph.getAttribute('data-visible-node-count')) >= 2;
    }, null, { timeout: 30_000 });
    await graphPage.getByText('以列表浏览当前节点').click();
    await graphPage.getByRole('button', { name: '社区生态证据', exact: true }).waitFor();
    await graphPage.screenshot({ path: path.join(output, 'teacher-textbook-real-graph.png') });
    await graphPage.reload({ waitUntil: 'domcontentloaded' });
    await graphPage.waitForFunction(() => {
      const graph = document.querySelector('[data-graph-ready]');
      return graph?.getAttribute('data-graph-ready') === 'true' && Number(graph.getAttribute('data-visible-node-count')) >= 2;
    }, null, { timeout: 30_000 });
    assert.equal((await checkedRequest(teacher, 'GET', `/api/textbooks/${textbook.id}`)).concepts.length, 2);
    record('textbook-real-docx-graph-and-evidence-persisted', '通过', '2 个知识点与原文证据，浏览器图谱绘制后刷新保持');
    await graphPage.close();
  } catch (error) { record('textbook-real-docx-graph-and-evidence-persisted', '失败', String(error.message).slice(0, 300)); }
  const pdf = await PDFDocument.create();
  pdf.addPage([600, 400]);
  const pdfBytes = Buffer.from(await pdf.save());
  const uploadedPdfResponse = await teacher.request.post(`${origin}/api/uploads`, {
    multipart: { file: { name: 'prelaunch.pdf', mimeType: 'application/pdf', buffer: pdfBytes }, title: '上线验收 PDF' },
    headers: { Origin: origin },
  });
  assert.equal(uploadedPdfResponse.status(), 201);
  const uploadedPdf = await uploadedPdfResponse.json();
  const downloadedPdf = await teacher.request.get(`${origin}${uploadedPdf.url}`, { headers: { Range: 'bytes=0-15' } });
  assert.equal(downloadedPdf.status(), 206);
  assert.equal((await downloadedPdf.body()).toString(), pdfBytes.subarray(0, 16).toString());
  record('pdf-upload-download-range-and-isolated-storage', '通过');
  try {
    const sampleRate = 16_000;
    const wav = Buffer.alloc(44 + sampleRate * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(sampleRate * 2, 40);
    for (let sample = 0; sample < sampleRate; sample++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 1000), 44 + sample * 2);
    const recorder = await browser.newContext({ recordVideo: { dir: path.join(temporary, 'recorded-video'), size: { width: 320, height: 180 } } });
    const recordedPage = await recorder.newPage();
    await recordedPage.setContent('<body style="background:#173b3c;color:white"><h1>CoTeach 媒体验收</h1></body>');
    await recordedPage.waitForTimeout(1200);
    await recordedPage.close();
    const webm = readFileSync(await recordedPage.video().path());
    await recorder.close();
    assert.ok(webm.length > 1000, '测试视频录制为空');
    const assets = [];
    for (const [kind, filename, mimeType, bytes] of [
      ['audio', 'prelaunch.wav', 'audio/wav', wav], ['video', 'prelaunch.webm', 'video/webm', webm],
    ]) {
      const response = await teacher.request.post(`${origin}/api/uploads`, {
        multipart: { file: { name: filename, mimeType, buffer: bytes }, title: `上线验收 ${kind}` }, headers: { Origin: origin }, timeout: 30_000,
      });
      const uploaded = await response.json();
      assert.equal(response.status(), 201, `${filename} upload: ${JSON.stringify(uploaded).slice(0, 200)}`);
      const download = await teacher.request.get(`${origin}${uploaded.url}`);
      assert.equal(download.status(), 200);
      assert.deepEqual(await download.body(), bytes);
      assets.push({ kind, url: uploaded.url });
    }
    const mediaPage = await teacher.newPage();
    await mediaPage.goto(`${origin}/teacher/classes`, { waitUntil: 'domcontentloaded' });
    for (const asset of assets) {
      await mediaPage.evaluate(({ kind, url }) => {
        const media = document.createElement(kind);
        media.id = `prelaunch-${kind}`; media.src = url; media.controls = true;
        const button = document.createElement('button');
        button.id = `play-${kind}`; button.textContent = `播放 ${kind}`;
        button.addEventListener('click', () => { void media.play().catch((error) => { document.body.dataset.mediaError = String(error); }); });
        document.body.append(media, button);
      }, asset);
      await mediaPage.locator(`#play-${asset.kind}`).click();
      await mediaPage.waitForFunction((kind) => {
        const media = document.querySelector(`#prelaunch-${kind}`);
        return media?.currentTime > 0.1 || Boolean(document.body.dataset.mediaError);
      }, asset.kind, { timeout: 15_000 });
      assert.equal(await mediaPage.evaluate(() => document.body.dataset.mediaError || ''), '', `${asset.kind} playback failed`);
      assert.ok(await mediaPage.locator(`#prelaunch-${asset.kind}`).evaluate((media) => media.currentTime > 0.1));
    }
    await mediaPage.close();
    record('audio-video-upload-download-browser-playback', '通过');
  } catch (error) {
    record('audio-video-upload-download-browser-playback', '失败', String(error.message).slice(0, 350));
  }
  try {
    const resourceTemplate = (await checkedRequest(teacher, 'POST', '/api/platform/templates/pbl', {
      name: '上线验收资源包课程', subject: '生态学', grade: '本科一年级', hours: 3,
    }, 201)).templateId;
    assert.ok(resourceTemplate);
    const metadata = (resourceType) => `---\nhandoffFormatVersion: 1\nprojectId: "prelaunch-ecology"\nresourceType: ${resourceType}\nresourceVersion: 1\npackageId: "prelaunch-package"\npresentationVersion: 1\n---`;
    const knowledge = `${metadata('KNOWLEDGE')}\n\n# 城市生态调查\n\n## 学习范围\n\n### 1. 城市生态证据\n\n- ID：urban-ecology\n- 范围：观察社区树木和鸟类。\n- 证据状态：SUPPORTED\n\n#### 观察记录\n\n- ID：observation\n- 内容：按时间和位置记录真实观察。\n- 来源：KB:1\n`;
    const stages = [
      ['教师导入', 'INTRODUCTION', 15], ['学生与AI讲师学习', 'AI_LEARNING', 30],
      ['小组项目实践', 'PROJECT_WORK', 60], ['成果展示', 'SHOWCASE', 20], ['反思评价', 'REFLECTION', 10],
    ].map(([title, id, minutes], index) => `### ${index + 1}. ${title}\n\n- ID：${id}\n- 时间与课次：第1课时，${minutes}分钟\n\n#### 教师行动\n\n- 引导观察并检查证据。\n\n#### 学生行动\n\n- 独立记录社区生态证据。\n\n#### AI职责\n\n- 提示观察维度，不代替学生判断。\n\n#### 阶段产出\n\n- 个人观察记录。\n\n#### 课次检查点\n\n- 保存当前观察记录。\n\n#### 观察与介入\n\n- 检查记录能否追溯来源。`).join('\n\n');
    const lesson = `${metadata('LESSON_PLAN')}\n\n# 城市生态调查：初步教案设计\n\n## 本课概览\n\n- 课程：城市生态调查\n- 授课对象：本科一年级\n- 项目周期：3节课\n- 授课时间：3课时，每课时45分钟\n- 驱动问题：怎样用可复查的观察证据解释社区生态？\n- 成果形式：个人生态调查报告。\n- 完成方式：个人独立完成\n\n## 教学目标\n\n- 能够记录可追溯的生态观察证据。\n\n## 组织安排\n\n- AI使用原则：仅用于提示观察维度，不代替学生判断。\n\n## 课堂实施\n\n${stages}\n\n## 评价安排\n\n依据观察证据的准确性评价。\n\n## 学生反思\n\n1. 哪条证据最可靠？\n`;
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.addSlide().addText('城市生态调查：项目启动', { x: 0.8, y: 0.8, w: 10, h: 1, fontSize: 28 });
    const pptxBytes = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
    const archive = new JSZip();
    archive.file('知识点.md', knowledge); archive.file('教案.md', lesson); archive.file('项目启动.pptx', pptxBytes);
    const archiveBytes = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const uploadResponse = await teacher.request.post(`${origin}/api/uploads`, {
      multipart: { file: { name: 'prelaunch-package.zip', mimeType: 'application/zip', buffer: archiveBytes }, courseId: resourceTemplate, purpose: 'course-resource-package' },
      headers: { Origin: origin }, timeout: 90_000,
    });
    const uploadedArchive = await uploadResponse.json();
    assert.equal(uploadResponse.status(), 201, `resource upload: ${JSON.stringify(uploadedArchive).slice(0, 250)}`);
    assert.ok(uploadedArchive.id);
    await checkedRequest(teacher, 'POST', `/api/courses/${resourceTemplate}/resource-package`, { uploadId: uploadedArchive.id }, 202);
    let resourceJob;
    for (let attempt = 0; attempt < 90; attempt++) {
      resourceJob = (await checkedRequest(teacher, 'GET', `/api/courses/${resourceTemplate}/resource-package`)).job;
      if (['ready', 'failed', 'blocked', 'needs_selection'].includes(resourceJob?.status)) break;
      await delay(1000);
    }
    assert.equal(resourceJob?.status, 'ready', `resource package processing: ${resourceJob?.status} ${resourceJob?.message || resourceJob?.error || ''}`);
    assert.equal(resourceJob.package?.draft?.courseName, '城市生态调查');
    assert.equal(resourceJob.package?.draft?.knowledgePoints?.length, 1);
    assert.equal(resourceJob.package?.draft?.stages?.length, 5);
    assert.ok(resourceJob.package?.launchResourceId);
    const preview = await teacher.request.get(`${origin}/api/uploads/${resourceJob.package.launchResourceId}?variant=classroom`);
    assert.equal(preview.status(), 200);
    assert.equal((await PDFDocument.load(await preview.body())).getPageCount(), 1);
    const requiredPlanningIssues = resourceJob.package.planningIssues?.filter((issue) => issue.requiresAcknowledgement).map((issue) => issue.id) ?? [];
    const confirmed = (await checkedRequest(teacher, 'PATCH', `/api/courses/${resourceTemplate}/resource-package`, {
      action: 'confirm', revision: resourceJob.package.revision, draft: resourceJob.package.draft,
      ...(requiredPlanningIssues.length ? { acknowledgement: { issueVersion: resourceJob.package.planningIssueVersion, issueIds: requiredPlanningIssues } } : {}),
    })).job;
    assert.ok(confirmed?.package?.confirmedAt);
    assert.ok((await checkedRequest(teacher, 'GET', `/api/courses/${resourceTemplate}/resource-package`)).job?.package?.confirmedAt);
    await pageCheck(teacher, 'teacher/resource-package-verified', `/teacher/prepare/${resourceTemplate}/verify`, '城市生态调查');
    record('resource-package-real-zip-pptx-parse-pdf-confirm-persistence', '通过', `1 PPTX 页，${resourceJob.package.draft.stages.length} 阶段`);
  } catch (error) {
    record('resource-package-real-zip-pptx-parse-pdf-confirm-persistence', '失败', String(error.message).slice(0, 350));
  }
  const offering = (await checkedRequest(teacher, 'POST', '/api/platform/offerings', {
    name: '上线验收课程：城市生态调查', description: '隔离数据库验收数据', term: '2026 秋季',
  }, 201)).offering;
  assert.ok(offering?.id);
  await checkedRequest(teacher, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'open' });
  const invitation = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/invitation`, {})).invitation;
  const chapter = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters`, { title: '项目启动' }, 201)).chapter;
  assert.ok(invitation?.code && chapter?.id);
  await checkedRequest(teacher, 'PATCH', `/api/platform/chapters/${chapter.id}`, { isOpen: true });
  record('teacher-course-chapter-invite-persistence', '通过');

  const configs = {
    Assignment: { schemaVersion: 1, prompt: '记录社区观察证据' },
    Quiz: { schemaVersion: 1, questions: [{ id: 'q1', title: '写出一条证据', required: true }] },
    Form: { schemaVersion: 1, questions: [{ id: 'q1', title: '你发现了什么？', type: 'short-text', required: true }] },
    Resource: { schemaVersion: 1, content: '阅读社区生态调查材料' },
  };
  const activities = {};
  for (const [type, config] of Object.entries(configs)) {
    activities[type] = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`,
      { type, title: `${type} 验收`, config }, 201)).activity;
    await checkedRequest(teacher, 'PATCH', `/api/platform/activities/${activities[type].id}`, { isOpen: true });
  }
  record('teacher-four-activity-types-created', '通过');

  await checkedRequest(student, 'POST', '/api/platform/auth/invite', { code: invitation.code });
  await checkedRequest(student, 'POST', '/api/platform/auth/register', {
    invitationCode: invitation.code, username: 'prelaunch-student', displayName: '上线验收学生', password, confirmPassword: password,
  }, 201);
  record('student-invite-register-real-login-cookie', '通过');
  for (const legacyAuth of ['/api/auth/login', '/api/auth/register', '/api/auth/join']) {
    const retired = await checkedRequest(student, 'POST', legacyAuth, {}, 410);
    assert.equal(retired.code, 'V2_AUTH_REQUIRED');
  }
  record('legacy-account-api-explicitly-retired', '通过');
  await checkedRequest(student, 'GET', '/api/platform/offerings', undefined, 401);
  await checkedRequest(teacher, 'GET', '/api/platform/courses', undefined, 401);
  await checkedRequest(student, 'GET', `/api/platform/activities/${randomUUID()}`, undefined, 404);
  record('role-boundaries-and-invalid-activity', '通过');
  for (const [type, activity] of Object.entries(activities)) {
    const data = type === 'Assignment' ? { answer: '我观察到社区河流变清了。' }
      : type === 'Resource' ? { answer: '已阅读资料' }
      : { answers: { q1: '我观察到社区河流变清了。' } };
    await checkedRequest(student, 'POST', `/api/platform/activities/${activity.id}/submit`, data);
    const loaded = await checkedRequest(student, 'GET', `/api/platform/activities/${activity.id}`);
    assert.equal(loaded.activity.progress.status, 'completed');
    assert.equal(await db.activitySubmission.count({ where: { activityId: activity.id } }), 1);
    record(`student-${type.toLowerCase()}-submit-reload`, '通过');
  }
  for (const [type, activity] of Object.entries(activities)) {
    const page = await student.newPage();
    try {
      await page.goto(`${origin}/student/activities/${activity.id}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: `${type} 验收` }).waitFor();
      if (type === 'Resource') {
        await page.getByText('阅读社区生态调查材料').waitFor();
        await page.getByText('已学习', { exact: true }).waitFor();
      } else {
        const revised = `页面修改后保存：${type} 社区生态证据`;
        await page.locator('textarea').first().fill(revised);
        await page.getByRole('button', { name: type === 'Form' ? '更新回答' : '更新提交' }).click();
        await page.getByRole('status').filter({ hasText: type === 'Form' ? '回答已经保存' : '已保存' }).waitFor();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('textarea').first().waitFor();
        assert.equal(await page.locator('textarea').first().inputValue(), revised);
        const stored = await checkedRequest(student, 'GET', `/api/platform/activities/${activity.id}`);
        assert.equal(stored.activity.progress.status, 'completed');
      }
      record(`student-${type.toLowerCase()}-browser-edit-reload`, '通过');
    } catch (error) {
      await page.screenshot({ path: path.join(output, `student-${type.toLowerCase()}-browser-edit-failure.png`) }).catch(() => undefined);
      record(`student-${type.toLowerCase()}-browser-edit-reload`, '失败', String(error.message).slice(0, 300));
    } finally { await page.close(); }
  }
  const survey = await checkedRequest(teacher, 'GET', `/api/platform/activities/${activities.Form.id}/survey-results`);
  assert.equal(survey.analytics.submittedCount, 1);
  record('teacher-survey-sees-student-submission', '通过');

  const template = await checkedRequest(teacher, 'POST', '/api/platform/templates', {
    title: '上线验收课堂模板', snapshot: { schemaVersion: 1, title: '城市生态调查课堂' },
  }, 201);
  assert.ok(template?.versions?.[0]?.id);
  const secondVersion = (await checkedRequest(teacher, 'POST', `/api/platform/templates/${template.id}/versions`, {
    snapshot: { schemaVersion: 1, title: '城市生态调查课堂（第二版）' },
  }, 201)).version;
  assert.equal(secondVersion.version, 2);
  assert.equal((await db.classroomTemplateVersion.count({ where: { templateId: template.id } })), 2);
  record('teacher-template-version-published-and-persisted', '通过');
  let pblCreatePage;
  try {
    pblCreatePage = await teacher.newPage();
    await pblCreatePage.goto(`${origin}/teacher/templates/pbl/new`, { waitUntil: 'domcontentloaded' });
    await pblCreatePage.getByRole('textbox', { name: '课程名称' }).fill('上线验收 PBL 创建草稿');
    await pblCreatePage.getByRole('textbox', { name: '学科' }).fill('科学');
    await pblCreatePage.getByRole('textbox', { name: '年级' }).fill('七年级');
    await pblCreatePage.getByRole('spinbutton', { name: '课时' }).fill('1');
    await pblCreatePage.getByRole('button', { name: '创建并进入备课' }).click();
    await pblCreatePage.waitForURL(/\/teacher\/prepare\/[^/]+\/verify$/, { timeout: 30_000 });
    const pblCreatedId = new URL(pblCreatePage.url()).pathname.split('/')[3];
    const pblCreated = await db.classroomTemplate.findUniqueOrThrow({ where: { id: pblCreatedId } });
    assert.equal(pblCreated.title, '上线验收 PBL 创建草稿');
    await pblCreatePage.reload({ waitUntil: 'domcontentloaded' });
    await pblCreatePage.getByText('上线验收 PBL 创建草稿').first().waitFor();
    await pblCreatePage.screenshot({ path: path.join(output, 'teacher-pbl-draft-created.png') });
    record('teacher-pbl-browser-create-draft-persisted', '通过');
  } catch (error) {
    await pblCreatePage?.screenshot({ path: path.join(output, 'teacher-pbl-create-failure.png') }).catch(() => undefined);
    record('teacher-pbl-browser-create-draft-persisted', '失败', String(error.message).slice(0, 350));
  } finally { await pblCreatePage?.close(); }
  if (process.env.PRELAUNCH_REAL_PROVIDERS === '1') {
    let generationPage;
    try {
      const generatedTitle = '上线验收 AI 生成课程';
      generationPage = await teacher.newPage();
      await generationPage.goto(`${origin}/teacher/templates/new`, { waitUntil: 'domcontentloaded' });
      await generationPage.getByRole('textbox', { name: '课程名称' }).fill(generatedTitle);
      await generationPage.getByRole('textbox', { name: '学科领域' }).fill('科学');
      await generationPage.getByRole('textbox', { name: '适用年级' }).fill('七年级');
      await generationPage.getByRole('spinbutton', { name: '课程时长（分钟）' }).fill('20');
      await generationPage.getByRole('textbox', { name: '教学要求' }).fill('围绕社区树木与鸟类观察设计一节二十分钟的科学课，学生记录证据并提出一项可执行的保护行动。');
      await generationPage.route('**/api/platform/templates/generate', route => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ message: '验收注入的临时故障，请重试' }),
      }), { times: 1 });
      await generationPage.getByRole('button', { name: '生成课程方案' }).click();
      await generationPage.getByRole('alert').getByText('验收注入的临时故障，请重试').waitFor();
      assert.equal(await generationPage.getByRole('textbox', { name: '课程名称' }).inputValue(), generatedTitle);
      await generationPage.reload({ waitUntil: 'domcontentloaded' });
      await generationPage.waitForFunction((title) =>
        Array.from(document.querySelectorAll('input')).some((input) => input.value === title), generatedTitle);
      assert.equal(await generationPage.getByRole('textbox', { name: '课程名称' }).inputValue(), generatedTitle);
      let generated = false;
      for (let attempt = 0; attempt < 2 && !generated; attempt++) {
        const responseReady = generationPage.waitForResponse(response =>
          new URL(response.url()).pathname === '/api/platform/templates/generate' && response.request().method() === 'POST',
        { timeout: 150_000 });
        await generationPage.getByRole('button', { name: '生成课程方案' }).click();
        const response = await responseReady;
        generated = response.ok();
        if (!generated && attempt === 1) throw new Error(`真实课程生成连续失败，末次 HTTP ${response.status()}`);
      }
      await generationPage.getByRole('heading', { name: '完善课程内容' }).waitFor({ timeout: 150_000 });
      assert.ok((await generationPage.getByRole('textbox', { name: '课程简介' }).inputValue()).trim());
      await generationPage.getByRole('button', { name: '预览课程' }).click();
      await generationPage.getByText('03 / 发布确认').waitFor();
      await generationPage.getByRole('button', { name: '发布到课程库' }).click();
      await generationPage.waitForURL('**/teacher/templates?created=1', { timeout: 30_000 });
      await generationPage.getByText(generatedTitle).first().waitFor();
      const generatedTemplate = await db.classroomTemplate.findFirstOrThrow({
        where: { title: generatedTitle }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      assert.ok(generatedTemplate.versions[0]?.snapshot?.outline?.length, 'AI 生成内容未保存到模板版本');
      await generationPage.reload({ waitUntil: 'domcontentloaded' });
      await generationPage.getByText(generatedTitle).first().waitFor();
      await generationPage.screenshot({ path: path.join(output, 'teacher-normal-ai-generated-published.png') });
      record('teacher-normal-ai-generation-failure-retry-publish-persisted', '通过');
    } catch (error) {
      await generationPage?.screenshot({ path: path.join(output, 'teacher-normal-ai-generation-failure.png') }).catch(() => undefined);
      record('teacher-normal-ai-generation-failure-retry-publish-persisted', '失败', String(error.message).slice(0, 350));
    } finally { await generationPage?.close(); }
  }
  let editorPage;
  try {
    const editorId = `prelaunch-editor-${randomUUID()}`;
    const editorClassroomId = `prelaunch-classroom-${randomUUID()}`;
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();
    const editorCourse = {
      id: editorId, name: '上线验收真实课堂编辑', subject: '科学', grade: '七年级', hours: 1,
      summary: '', drivingQuestion: '怎样记录社区生态证据？', status: 'draft', stages: [],
      currentStageIndex: 0, students: [], resources: [], groups: [],
      aiLearningClassroomId: editorClassroomId,
      content: { pblOutline: '', knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
      createdAt: now, updatedAt: now, version: 1,
    };
    await checkedRequest(teacher, 'POST', `/api/courses/${editorId}/actions`, {
      requestId: randomUUID(), action: { type: 'CREATE_COURSE', payload: editorCourse },
    });
    const editorResource = {
      id: editorClassroomId, createdAt: now, updatedAt: now, revision: 1,
      stage: { id: editorClassroomId, name: '社区生态 AI 课堂', createdAt: timestamp, updatedAt: timestamp },
      scenes: [{
        id: `scene-${randomUUID()}`, stageId: editorClassroomId, title: '观察社区生态', type: 'slide', order: 0,
        createdAt: timestamp, updatedAt: timestamp,
        content: { type: 'slide', schemaVersion: 1, canvas: {
          id: `canvas-${randomUUID()}`, viewportSize: 1000, viewportRatio: 0.5625,
          elements: [], background: { type: 'solid', color: '#ffffff' },
          theme: { backgroundColor: '#ffffff', themeColors: ['#344a6a'], fontColor: '#243447', fontName: 'Noto Sans SC',
            outline: { color: '#344a6a', width: 2, style: 'solid' }, shadow: { h: 0, v: 0, blur: 0, color: '#000000' } },
        } },
        actions: [{ id: `speech-${randomUUID()}`, type: 'speech', text: '观察社区树木和鸟类。' }],
      }],
    };
    mkdirSync(env.CLASSROOM_DATA_DIR, { recursive: true });
    writeFileSync(path.join(env.CLASSROOM_DATA_DIR, `${editorClassroomId}.json`), JSON.stringify(editorResource));
    editorPage = await teacher.newPage();
      await editorPage.goto(`${origin}/teacher/prepare/${editorId}/classroom-editor`, { waitUntil: 'domcontentloaded' });
      await editorPage.getByRole('button', { name: '添加白板', exact: true }).waitFor({ timeout: 30_000 });
      await editorPage.getByRole('button', { name: '添加白板', exact: true }).click();
      const dialog = editorPage.getByRole('dialog', { name: '编辑白板', exact: true });
      await dialog.getByRole('textbox', { name: '板书内容', exact: true }).fill('持久保存的社区观察要点');
      await dialog.getByRole('button', { name: '完成编辑', exact: true }).click();
      await editorPage.getByRole('button', { name: '保存课堂', exact: true }).click();
      await editorPage.getByText(/^所有修改已保存/).waitFor({ timeout: 30_000 });
      const saved = (await checkedRequest(teacher, 'GET', `/api/courses/${editorId}/classroom-resource`)).classroom;
      assert.ok(saved.revision > editorResource.revision, '课堂修订号未推进');
      assert.ok(saved.scenes[0].actions.some((action) => action.type === 'wb_draw_text' && action.content === '持久保存的社区观察要点'));
      await editorPage.reload({ waitUntil: 'domcontentloaded' });
      await editorPage.getByRole('button', { name: '编辑白板内容与讲解', exact: true }).click();
      await editorPage.getByRole('dialog', { name: '编辑白板', exact: true })
        .getByRole('textbox', { name: '板书内容', exact: true }).waitFor();
      assert.equal(await editorPage.getByRole('dialog', { name: '编辑白板', exact: true })
        .getByRole('textbox', { name: '板书内容', exact: true }).inputValue(), '持久保存的社区观察要点');
      const storedCourse = await db.classroomTemplate.findUniqueOrThrow({ where: { id: editorId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
      assert.equal(storedCourse.versions[0].snapshot.design.aiLearningClassroomId, editorClassroomId);
      await editorPage.screenshot({ path: path.join(output, 'teacher-classroom-editor-real-saved.png') });
      record('teacher-classroom-editor-browser-save-storage-reload', '通过', `资源修订号 ${saved.revision}`);
  } catch (error) {
    await editorPage?.screenshot({ path: path.join(output, 'teacher-classroom-editor-real-failure.png') }).catch(() => undefined);
    record('teacher-classroom-editor-browser-save-storage-reload', '失败', String(error.message).slice(0, 350));
  } finally { await editorPage?.close(); }
  const classroomActivity = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
    type: 'Classroom', title: '课堂验收', templateVersionId: template.versions[0].id, config: { schemaVersion: 1 },
  }, 201)).activity;
  await checkedRequest(teacher, 'PATCH', `/api/platform/activities/${classroomActivity.id}`, { isOpen: true });
  const instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: classroomActivity.id } });
  await checkedRequest(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
  const entered = await checkedRequest(student, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {});
  const participationId = entered.participation?.id;
  assert.ok(participationId);
  await pageCheck(teacher, 'teacher/legacy-template-setup', `/teacher/teach/${template.id}/setup`, '上线验收课堂模板');
  const disabledDiscussion = [/^404 \/api\/courses\/[^/]+\/public-discussion(?:\/settings)?$/];
  await pageCheck(teacher, 'teacher/live-classroom', `/teacher/teach/${instance.id}/classroom`, '课堂数据速览', disabledDiscussion);
  await pageCheck(student, 'student/live-classroom', `/student/classroom/${instance.id}`, '当前学习任务', disabledDiscussion);
  await checkedRequest(student, 'PATCH', `/api/platform/participations/${participationId}`, {
    version: 0, idempotencyKey: randomUUID(), document: '城市生态调查报告', code: 'print("你好，CoTeach")', stageKey: 'make',
  });
  const reloadedWorkspace = await checkedRequest(student, 'GET', `/api/platform/participations/${participationId}`);
  assert.equal(reloadedWorkspace.workspace.projectState.document, '城市生态调查报告');
  assert.equal(reloadedWorkspace.workspace.projectState.code, 'print("你好，CoTeach")');
  record('classroom-create-start-enter-and-workspace-reload', '通过');
  if (process.env.PRELAUNCH_REAL_PROVIDERS === '1') {
    try {
      const created = await checkedRequest(student, 'POST', `/api/platform/participations/${participationId}/ai`, {
        op: 'create_conversation', idempotencyKey: randomUUID(), title: '社区生态调查证据讨论',
      });
      const conversation = created.conversations.find((item) => item.title === '社区生态调查证据讨论');
      assert.ok(conversation?.id, 'AI 会话未保存');
      const reply = await student.request.post(`${origin}/api/platform/participations/${participationId}/ai`, {
        data: { op: 'send_message', idempotencyKey: randomUUID(), conversationId: conversation.id, content: '请用一句话建议如何记录社区鸟类观察证据。' },
        headers: { Origin: origin }, timeout: 120_000,
      });
      const answered = await reply.json();
      assert.equal(reply.status(), 200, `AI message: ${JSON.stringify(answered).slice(0, 300)}`);
      const persisted = await checkedRequest(student, 'GET', `/api/platform/participations/${participationId}/ai`);
      const messages = persisted.conversations.find((item) => item.id === conversation.id)?.messages ?? [];
      assert.ok(messages.some((message) => message.role === 'user'));
      assert.ok(messages.some((message) => message.role === 'assistant' && message.content?.trim()), 'AI 组员未返回并保存真实答复');
      assert.ok(await db.aiMessage.count({ where: { conversationId: conversation.id, role: 'assistant' } }));
      record('student-ai-real-reply-consumed-and-persisted', '通过');
    } catch (error) { record('student-ai-real-reply-consumed-and-persisted', '失败', String(error.message).slice(0, 350)); }
  }
  const artifact = (await checkedRequest(student, 'POST', `/api/platform/participations/${participationId}/outcomes`, {
    action: 'save_artifact', idempotencyKey: randomUUID(), title: '生态调查成果', type: 'HTML', sourceHtml: '<h1>城市生态调查</h1>',
  })).outcome;
  assert.ok(artifact?.id);
  await checkedRequest(student, 'POST', `/api/platform/participations/${participationId}/outcomes`, {
    action: 'submit_stage', idempotencyKey: randomUUID(), stageKey: 'make', payload: { summary: '调查完成' },
  });
  await checkedRequest(student, 'POST', `/api/platform/participations/${participationId}/outcomes`, {
    action: 'reflect', idempotencyKey: randomUUID(), content: '我学会了比较社区生态证据。',
  });
  const outcomes = await checkedRequest(teacher, 'GET', `/api/platform/participations/${participationId}/outcomes`);
  assert.equal(outcomes.artifacts.length, 1);
  assert.equal(outcomes.submissions.length, 1);
  assert.equal(outcomes.reflections.length, 1);
  await checkedRequest(teacher, 'POST', `/api/platform/participations/${participationId}/outcomes`, {
    action: 'evaluate', idempotencyKey: randomUUID(), type: 'FORMATIVE', score: 86, content: '证据充分，继续完善方案。',
  });
  assert.equal((await checkedRequest(student, 'GET', `/api/platform/participations/${participationId}/outcomes`)).evaluations.length, 1);
  await checkedRequest(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {});
  assert.equal((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).status.toLowerCase(), 'finished');
  record('classroom-artifact-stage-reflection-evaluation-finish', '通过');

  await pageCheck(teacher, 'teacher/classes', '/teacher/classes', '上线验收课程');
  await pageCheck(teacher, 'teacher/course-detail', `/teacher/classes/${offering.id}`, '上线验收课程');
  await pageCheck(teacher, 'teacher/students', `/teacher/classes/${offering.id}/students`, '上线验收学生');
  await pageCheck(teacher, 'teacher/survey', `/teacher/surveys/${activities.Form.id}`, '你发现了什么');
  await pageCheck(teacher, 'teacher/templates', '/teacher/templates', '上线验收课堂模板');
  await pageCheck(teacher, 'teacher/template-create', '/teacher/templates/new', '创建课程');
  await pageCheck(teacher, 'teacher/pbl-create', '/teacher/templates/pbl/new', '创建 PBL 课程');
  await pageCheck(teacher, 'teacher/textbook-library', '/teacher/textbooks', '教材库');
  await pageCheck(teacher, 'teacher/experiment', `/teacher/classes/${offering.id}/activities/${classroomActivity.id}/experiment`, '前后测配置');
  await pageCheck(student, 'student/courses', '/student?all=1', '上线验收课程');
  await pageCheck(student, 'student/course-detail', `/student/courses/${offering.id}`, '上线验收课程');
  await pageCheck(student, 'student/profile', '/student/profile', '上线验收学生');
  await pageCheck(student, 'student/assignment', `/student/activities/${activities.Assignment.id}`, 'Assignment 验收');
  await pageCheck(student, 'student/survey', `/student/activities/${activities.Form.id}`, 'Form 验收');
  await pageCheck(student, 'student/invalid-activity-recovery', `/student/activities/${randomUUID()}`, '暂时无法打开活动', [/^404 \/api\/platform\/activities\/[^/]+$/]);
  await pageCheck(student, 'student/participation', `/student/participations/${participationId}`, '城市生态调查');
  await pageCheck(teacher, 'teacher/participation', `/teacher/participations/${participationId}`, '城市生态调查');
  await pageCheck(teacher, 'teacher/classroom-record', `/teacher/classrooms/${instance.id}`, '上线验收学生');
  await pageCheck(teacher, 'teacher/legacy-classroom-history', `/teacher/teach/${instance.id}/history`, '历史开课记录');
  const historyPage = await student.newPage();
  await historyPage.goto(`${origin}/student/courses/${offering.id}`);
  await historyPage.getByRole('heading', { name: /上线验收课程/ }).first().waitFor();
  await historyPage.goto(`${origin}/student/activities/${activities.Assignment.id}`);
  await historyPage.getByRole('heading', { name: 'Assignment 验收' }).waitFor();
  await historyPage.goBack();
  await historyPage.getByRole('heading', { name: /上线验收课程/ }).first().waitFor();
  await historyPage.goForward();
  await historyPage.getByRole('heading', { name: 'Assignment 验收' }).waitFor();
  await historyPage.close();
  record('student-deep-link-back-forward-new-tab', '通过');
  const redirects = [
    [teacher, '/teacher', '/teacher/classes'],
    [teacher, `/teacher/classes/${offering.id}/access`, `/teacher/classes/${offering.id}`],
    [student, '/student', `/student/courses/${offering.id}`],
  ];
  for (const [context, route, destination] of redirects) {
    const page = await context.newPage();
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(`${origin}${destination}`, { timeout: 20_000 });
    await page.close();
    record(`redirect-${route}`, '通过', destination);
  }
  const anonymous = await browser.newContext();
  for (const [route, login] of [['/teacher/classes', '/teacher/login'], ['/student/profile', '/student/login']]) {
    const page = await anonymous.newPage();
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    assert.equal(new URL(page.url()).pathname, login);
    await page.close();
    record(`anonymous-${route}-login-return`, '通过', login);
  }
  await anonymous.close();

  const teacherOfferings = await checkedRequest(teacher, 'GET', '/api/platform/offerings');
  assert.ok(teacherOfferings.offerings.some((entry) => entry.id === offering.id));
  const studentCourses = await checkedRequest(student, 'GET', '/api/platform/courses');
  assert.ok(studentCourses.courses.some((entry) => entry.id === offering.id));
  record('teacher-and-student-reload-persisted-course', '通过');

  const enrollment = await db.enrollment.findFirstOrThrow({ where: { offeringId: offering.id } });
  const reset = await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/reset-password`, { enrollmentId: enrollment.id }, 201);
  assert.ok(reset.token);
  await pageCheck(student, 'student/reset-password', `/student/reset-password?token=${reset.token}`, '设置新密码');
  const newPassword = `${password}New`;
  await checkedRequest(student, 'POST', '/api/platform/auth/reset-password', { token: reset.token, password: newPassword });
  await checkedRequest(student, 'GET', '/api/platform/courses', undefined, 401);
  const expiredPage = await student.newPage();
  await expiredPage.goto(`${origin}/student/courses/${offering.id}`);
  await expiredPage.waitForURL('**/student/login**');
  await expiredPage.close();
  record('expired-student-deep-link-redirects-to-login', '通过');
  const relogged = await browser.newContext();
  await checkedRequest(relogged, 'POST', '/api/platform/auth/login', { username: 'prelaunch-student', password: newPassword });
  assert.ok((await checkedRequest(relogged, 'GET', '/api/platform/courses')).courses.some((entry) => entry.id === offering.id));
  record('student-password-reset-invalidates-session-and-relogin', '通过');
  try {
    const anotherTab = await relogged.newPage();
    await anotherTab.goto(`${origin}/student/courses/${offering.id}`, { waitUntil: 'domcontentloaded' });
    await anotherTab.getByText('上线验收课程').first().waitFor();
    await anotherTab.reload({ waitUntil: 'domcontentloaded' });
    await anotherTab.getByText('上线验收课程').first().waitFor();
    await relogged.setOffline(true);
    try { await anotherTab.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }); }
    catch { /* The browser shows its own offline page when no HTML can load. */ }
    await relogged.setOffline(false);
    await anotherTab.reload({ waitUntil: 'domcontentloaded' });
    await anotherTab.getByText('上线验收课程').first().waitFor();
    await anotherTab.close();
    record('student-new-tab-shares-real-session-and-recovers-offline-reload', '通过');
  } catch (error) { record('student-new-tab-shares-real-session-and-recovers-offline-reload', '失败', String(error.message).slice(0, 300)); }
  try {
    const enrollment = await db.enrollment.findFirstOrThrow({ where: { offeringId: offering.id } });
    const exportResponse = await teacher.request.post(`${origin}/api/platform/offerings/${offering.id}/students/export`, {
      data: { enrollmentIds: [enrollment.id], sections: ['summary', 'activity_submissions', 'classrooms', 'summary_csv'] },
      headers: { Origin: origin }, timeout: 90_000,
    });
    assert.equal(exportResponse.status(), 200, `student export: ${exportResponse.status()}`);
    const exportedZip = await JSZip.loadAsync(await exportResponse.body());
    assert.ok(Object.keys(exportedZip.files).some((name) => name.endsWith('.csv')));
    record('teacher-student-records-real-zip-export', '通过');

    const expiringInvitation = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/invitation`, {
      expiresAt: new Date(Date.now() + 3000).toISOString(),
    })).invitation;
    assert.ok(expiringInvitation.code);
    const visitor = await browser.newContext();
    await checkedRequest(visitor, 'POST', '/api/platform/auth/invite', { code: expiringInvitation.code });
    await delay(3300);
    const expiredPreview = await checkedRequest(visitor, 'POST', '/api/platform/auth/invite', { code: expiringInvitation.code }, 404);
    assert.equal(expiredPreview.code, 'INVITE_CODE_INVALID');
    const expiredRegistration = await checkedRequest(visitor, 'POST', '/api/platform/auth/register', {
      invitationCode: expiringInvitation.code, username: 'expired-invite-student', displayName: '过期邀请码学生', password, confirmPassword: password,
    }, 404);
    assert.equal(expiredRegistration.code, 'INVITE_CODE_INVALID');
    await visitor.close();
    assert.equal(await db.user.count({ where: { username: 'expired-invite-student' } }), 0);
    record('teacher-invitation-expiry-blocks-preview-and-registration', '通过');

    const disabledInvitation = (await checkedRequest(teacher, 'POST', `/api/platform/offerings/${offering.id}/invitation`, { disabled: true })).invitation;
    assert.equal(disabledInvitation.status.toLowerCase(), 'disabled');
    const disabledVisitor = await browser.newContext();
    const invalidInvite = await disabledVisitor.request.post(`${origin}/api/platform/auth/invite`, {
      data: { code: disabledInvitation.code }, headers: { Origin: origin },
    });
    assert.ok(invalidInvite.status() >= 400, `disabled invitation accepted: ${invalidInvite.status()}`);
    await disabledVisitor.close();
    record('teacher-invitation-disable-rejects-new-join', '通过');

    await checkedRequest(teacher, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'finished' });
    assert.equal((await db.courseOffering.findUniqueOrThrow({ where: { id: offering.id } })).status.toLowerCase(), 'finished');
    assert.ok((await checkedRequest(relogged, 'GET', '/api/platform/courses')).courses.some((entry) => entry.id === offering.id && entry.status.toLowerCase() === 'finished'));
    await checkedRequest(teacher, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'archived' });
    assert.equal((await db.courseOffering.findUniqueOrThrow({ where: { id: offering.id } })).status.toLowerCase(), 'archived');
    record('teacher-finish-and-archive-course-persisted', '通过');

    const withdrawn = await checkedRequest(teacher, 'DELETE', `/api/platform/offerings/${offering.id}/students/${enrollment.id}`);
    assert.equal(withdrawn.status, 'withdrawn');
    assert.equal((await db.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } })).status.toLowerCase(), 'withdrawn');
    assert.ok(!(await checkedRequest(relogged, 'GET', '/api/platform/courses')).courses.some((entry) => entry.id === offering.id));
    record('teacher-withdraw-student-revokes-course-access', '通过');
  } catch (error) { record('teacher-course-access-and-member-lifecycle', '失败', String(error.message).slice(0, 300)); }
  await relogged.close();
  const logout = await teacher.request.post(`${origin}/api/auth/logout`, { headers: { Origin: origin, 'X-OpenPBL-Role': 'teacher' } });
  assert.equal(logout.status(), 200);
  await checkedRequest(teacher, 'GET', '/api/platform/offerings', undefined, 401);
  record('teacher-logout-invalidates-session', '通过');
  await teacher.close();
  await student.close();
} catch (error) {
  record('fatal', '失败', String(error.message).slice(0, 500));
  const diagnostics = serverOutput.split('\n').filter((line) => /Error:|Module not found|Cannot find module/.test(line)).slice(-5);
  if (diagnostics.length) record('server-diagnostics', '失败', diagnostics.join(' | ').replace(/postgres(?:ql)?:\/\/\S+/g, '[database]'));
  process.exitCode = 1;
} finally {
  report();
  await browser?.close();
  await db?.$disconnect();
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* exited */ }
    await delay(1000);
    if (server.exitCode === null) try { process.kill(-server.pid, 'SIGKILL'); } catch { /* exited */ }
  }
  if (started) try { command('docker', ['rm', '--force', container]); } catch { /* exited */ }
  if (redisStarted) try { command('docker', ['rm', '--force', redisContainer]); } catch { /* exited */ }
  rmSync(temporary, { recursive: true, force: true });
  // The isolated dev build never owns the deployed production directory.
  rmSync(path.join(root, distDir), { recursive: true, force: true });
  // Next adds every temporary dist to tsconfig includes. Remove only our two
  // entries so a disposable acceptance run leaves the working tree unchanged.
  const tsconfigFile = path.join(root, 'tsconfig.json');
  const tsconfig = readFileSync(tsconfigFile, 'utf8');
  const generatedIncludes = `,\n    ${JSON.stringify(`${distDir}/types/**/*.ts`)},\n    ${JSON.stringify(`${distDir}/dev/types/**/*.ts`)}`;
  if (tsconfig.includes(generatedIncludes)) {
    writeFileSync(tsconfigFile, tsconfig.replace(generatedIncludes, ''));
  }
  if (results.some((entry) => entry.status === '失败')) process.exitCode = 1;
}
