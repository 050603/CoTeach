/** Summarize real renderer measurements and preserve every generated result.
 * node scripts/audit-approved-teaching-visuals.mjs --input=.openpbl-runtime/approved-visuals/model-run
 * This report is diagnostic; individual images still need visual/source review.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...values] = arg.replace(/^--/, '').split('='); return [key, values.join('=')]; }));
if (!args.get('input')) throw new Error('需要 --input');
const input = path.resolve(process.cwd(), args.get('input'));
if (!input.startsWith(path.resolve('.openpbl-runtime') + path.sep)) throw new Error('只允许隔离目录');
const json = async (filename) => JSON.parse(await readFile(filename, 'utf8'));
const summary = await json(path.join(input, 'summary.json'));
const accepted = await json(path.join(input, 'acceptance-report.json'));
const results = await Promise.all((await readdir(path.join(input, 'results'))).filter((name) => name.endsWith('.json')).sort().map((name) => json(path.join(input, 'results', name))));
const pages = [];
for (const result of results) {
  const contents = result.final ? [result.final, ...(result.final.continuationPages ?? [])] : [];
  for (let index = 0; index < contents.length; index++) {
    const id = `${result.id}-final-p${index + 1}`, render = await json(path.join(input, 'renders', `${id}.json`));
    const measured = render.referenceVisualMeasurements;
    if (!measured) throw new Error(`缺少新实际DOM/SVG审图结果：${id}`);
    const content = contents[index], visualPage = content.teachingVisual?.scene.pages.find((page) => page.id === content.teachingVisual.pageId);
    pages.push({ id, caseId: result.caseId, generatedPageIndex: index, title: visualPage?.title ?? result.source.title,
      screenshot: `renders/${id}.png`, rawResponseDirectory: `attempts/${result.id}`,
      classification: result.attemptClassification, source: result.source, requiredTeachingChecks: result.referenceChecks,
      firstRawGeometryCompiled: Boolean(result.first), qualityDiagnostics: result.qualityDiagnostics,
      nativeTypes: [...new Set(content.elements.map((element) => element.type))],
      renderIssues: render.issues, essentialFontIssues: render.essentialFontIssues,
      textLineDiagnostics: measured.textLines.filter((line) => line.diagnostics.length),
      lineTextIntersections: measured.lineTextIntersections,
      directedPaths: measured.linePaths.filter((line) => line.directed).map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'points'))),
      pathMeasurementFailures: measured.linePaths.filter((line) => line.diagnostic),
      declaredVisualHierarchy: visualPage?.components.map((component) => ({ id: component.id, role: component.role,
        kind: component.kind, anchorNodeId: component.anchorNodeId, icons: component.nodes.filter((node) => node.icon).map((node) => ({ nodeId: node.id, icon: node.icon })) })),
      contentReview: 'pending', beautyReview: 'pending', reviewMethod: '实际原生画布字形/曲线测量+待逐页人工查看，不能以无溢出替代美观。' });
  }
}
const classification = {};
for (const result of results) {
  const key = result.attemptClassification?.classification ?? result.status;
  classification[key] = (classification[key] ?? 0) + 1;
}
const report = { mode: summary.mode, sourceModelDirectory: summary.sourceModelDirectory,
  implementationSha256: summary.implementationSha256, providerCalls: summary.providerCalls,
  generatedCases: results.length, renderedFinalPages: pages.length, classification,
  sourcePreservation: await json(path.join(input, 'source-preservation.json')),
  reference: summary.approvedReference, renderFailures: accepted.renderFailures, nativeExportFailures: accepted.exportFailures,
  lineTextIntersectionCount: pages.reduce((sum, page) => sum + page.lineTextIntersections.length, 0),
  textLineReviewCount: pages.reduce((sum, page) => sum + page.textLineDiagnostics.length, 0),
  firstLocalRepairAndFallbackResultsPreserved: true, contentReview: 'pending', beautyReview: 'pending', teacherAcceptance: 'pending',
  fullStudentScreenReview: 'not-run', pages,
  limitations: ['这些诊断只衡量实际排版，不证明教学事实或美观已通过。', '逐页核对主体、真实顺序/分支/回路、箭头端点和路径、标注邻近及段落密度。',
    '图形中心线轨迹不包含marker箭头头部；相交命中需图像复核，不能据此删内容或缩字号。', '新音频、原课程、DB和部署均未改。'] };
await writeFile(path.join(input, 'approved-style-audit.json'), JSON.stringify(report, null, 2) + '\n');
const escape = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const referenceImages = await Promise.all(summary.approvedReference.manifest.filter((item) => item.filename.endsWith('.png')).map(async (item) => ({ name: item.filename,
  url: `data:image/png;base64,${(await readFile(path.join(summary.approvedReference.directory, item.filename))).toString('base64')}` })));
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>认可样稿与实际生成逐页核对</title><style>body{margin:28px;background:#edf2f6;color:#22364f;font:16px sans-serif}main{max-width:1200px;margin:auto}.refs{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:22px 0}img{width:100%;display:block;background:white;border:1px solid #d8e1ec}figcaption{padding:10px 0;line-height:1.5}pre{white-space:pre-wrap;font:14px monospace}</style><main><h1>已认可样稿与实际生成</h1><p>本轮实际模型/保存响应重放与手工参考分别保留，provider=${escape(summary.providerCalls)}。内容及美观仍需逐页评审，无溢出不能代替美观。</p><div class="refs">${referenceImages.map((item) => `<figure><img src="${item.url}"><figcaption>已认可手工参考 ${escape(item.name)}</figcaption></figure>`).join('')}</div>${pages.map((page) => `<figure><h2>${escape(page.title)} · ${escape(page.caseId)}</h2><img src="${escape(page.screenshot)}"><figcaption>${escape(page.classification?.classification)}；穿字诊断${page.lineTextIntersections.length}；孤字/孤词/密集文字提示${page.textLineDiagnostics.length}</figcaption><pre>${escape(JSON.stringify({ teachingChecks: page.requiredTeachingChecks, lineIntersections: page.lineTextIntersections, textDiagnostics: page.textLineDiagnostics, qualityDiagnostics: page.qualityDiagnostics }, null, 2))}</pre></figure>`).join('')}</main></html>`;
await writeFile(path.join(input, 'approved-style-gallery.html'), html);
console.log(JSON.stringify({ generatedCases: results.length, finalPages: pages.length, classification,
  lineTextIntersections: report.lineTextIntersectionCount, textReviewPrompts: report.textLineReviewCount,
  contentReview: report.contentReview, beautyReview: report.beautyReview }));
