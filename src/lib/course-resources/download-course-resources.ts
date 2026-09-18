'use client';

import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
import type { Scene, SlideContent } from '@openmaic/lib/types/stage';

type ResourceDownloadPayload = {
  schemaVersion: 1;
  course: { id: string; name: string; subject?: string; grade?: string; updatedAt?: string };
  classrooms: Array<{
    kind: 'main' | 'teacher' | 'adaptive';
    label: string;
    classroom: PersistedClassroomData;
  }>;
  sourceFiles: Array<{ fileName: string; url: string }>;
};

function safeFileName(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.+$/g, '');
  return normalized || fallback;
}

type ClassroomAsset = { url: string; label: string; fallbackExtension: string };

function collectClassroomAssets(classroom: PersistedClassroomData): ClassroomAsset[] {
  const assets: ClassroomAsset[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, label: string, fallbackExtension: string) => {
    if (typeof url !== 'string' || !url.trim() || url.startsWith('data:') || seen.has(url)) return;
    if (!/^(?:https?:\/\/|\/)/i.test(url)) return;
    seen.add(url);
    assets.push({ url, label, fallbackExtension });
  };

  classroom.scenes.forEach((scene, sceneIndex) => {
    const prefix = `${String(sceneIndex + 1).padStart(2, '0')}-${safeFileName(scene.title, '页面')}`;
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech') add(action.audioUrl, `${prefix}-讲稿音频`, '.wav');
    }
    if (scene.content.type !== 'slide') return;
    scene.content.canvas.elements.forEach((element, elementIndex) => {
      const record = element as unknown as Record<string, unknown>;
      const label = `${prefix}-素材${String(elementIndex + 1).padStart(2, '0')}`;
      add(record.src, label, record.type === 'video' ? '.mp4' : '.png');
      add(record.poster, `${label}-封面`, '.jpg');
      add(record.posterUrl, `${label}-封面`, '.jpg');
    });
  });
  return assets;
}

function assetExtension(url: string, fallback: string): string {
  try {
    const match = new URL(url, window.location.href).pathname.match(/\.[a-z0-9]{2,5}$/i);
    return match?.[0] ?? fallback;
  } catch {
    return fallback;
  }
}

export function buildClassroomScript(classroom: PersistedClassroomData, label: string): string {
  const sections = classroom.scenes.map((scene, index) => {
    const speeches = (scene.actions ?? [])
      .filter((action) => action.type === 'speech')
      .map((action, speechIndex) => `${speechIndex + 1}. ${action.text.trim()}`)
      .filter((line) => !line.endsWith('. '));
    return [
      `## ${index + 1}. ${scene.title || `第 ${index + 1} 页`}`,
      '',
      speeches.length ? speeches.join('\n\n') : '（本页无讲稿）',
    ].join('\n');
  });
  return [`# ${label}讲稿`, '', ...sections, ''].join('\n');
}

async function responseError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error || `下载资源失败（HTTP ${response.status}）`;
}

async function fetchSourceFile(url: string): Promise<Blob> {
  const absolute = new URL(url, window.location.href);
  const sameOrigin = absolute.origin === window.location.origin;
  const response = sameOrigin
    ? await fetch(absolute.href, { credentials: 'same-origin' })
    : await fetch('/api/proxy-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: absolute.href }),
      });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

export async function downloadCourseResources(courseId: string): Promise<void> {
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/resource-download`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(await responseError(response));
  const payload = await response.json() as ResourceDownloadPayload;

  const [{ default: JSZip }, fileSaverModule, { buildPptxBlob }, { inlineHtmlAssets, createAssetFetcher }, { createProxiedFetch }] = await Promise.all([
    import('jszip'),
    import('file-saver'),
    import('@openmaic/lib/export/use-export-pptx'),
    import('@openmaic/lib/export/inline-assets'),
    import('@openmaic/lib/export/proxied-fetch'),
  ]);
  // file-saver is CommonJS. Its dynamic import only exposes the callable as
  // `default` in the production bundle (unlike the static named-import shim).
  const saveAs = fileSaverModule.default;
  const zip = new JSZip();
  const warnings: string[] = [];
  const sharedFetcher = createAssetFetcher({ fetchImpl: createProxiedFetch() });

  for (const [classroomIndex, entry] of payload.classrooms.entries()) {
    const folderName = `${String(classroomIndex + 1).padStart(2, '0')}-${safeFileName(entry.label, '课堂资源')}`;
    const folder = zip.folder(folderName)!;
    const slideScenes = entry.classroom.scenes.filter(
      (scene): scene is Scene & { content: SlideContent } => scene.content.type === 'slide',
    );
    if (slideScenes.length > 0) {
      const firstCanvas = slideScenes[0].content.canvas;
      const viewportSize = firstCanvas.viewportSize || 1000;
      const viewportRatio = firstCanvas.viewportRatio || 0.5625;
      const pptx = await buildPptxBlob(
        slideScenes.map((scene) => scene.content.canvas),
        slideScenes,
        viewportRatio,
        viewportSize,
        96 * (viewportSize / 960),
        (96 / 72) * (viewportSize / 960),
      );
      folder.file(`${safeFileName(entry.label, '课程')}.pptx`, pptx);
    }
    folder.file('讲稿.md', buildClassroomScript(entry.classroom, entry.label));
    folder.file('课堂资源.json', JSON.stringify(entry.classroom, null, 2));

    for (const asset of collectClassroomAssets(entry.classroom)) {
      try {
        folder.file(
          `媒体/${safeFileName(asset.label, '课程素材')}${assetExtension(asset.url, asset.fallbackExtension)}`,
          await fetchSourceFile(asset.url),
        );
      } catch (error) {
        warnings.push(`${entry.label} / ${asset.label}：${error instanceof Error ? error.message : '下载失败'}`);
      }
    }

    let interactiveIndex = 0;
    for (const scene of entry.classroom.scenes) {
      if (scene.content.type !== 'interactive' || !scene.content.html) continue;
      interactiveIndex += 1;
      const result = await inlineHtmlAssets(scene.content.html, { fetcher: sharedFetcher });
      folder.file(
        `互动页面/${String(interactiveIndex).padStart(2, '0')}-${safeFileName(scene.title, '互动页面')}.html`,
        result.html,
      );
      if (result.report.failed.length > 0) {
        warnings.push(`${entry.label} / ${scene.title}：${result.report.failed.length} 个外部素材未能离线化`);
      }
    }
  }

  const sourceFolder = zip.folder('原始教学资料');
  for (const source of payload.sourceFiles) {
    try {
      sourceFolder?.file(safeFileName(source.fileName, '教学资料'), await fetchSourceFile(source.url));
    } catch (error) {
      warnings.push(`${source.fileName}：${error instanceof Error ? error.message : '下载失败'}`);
    }
  }

  zip.file('课程信息.json', JSON.stringify(payload.course, null, 2));
  zip.file('README.txt', [
    `${payload.course.name} · 完整课程资源`,
    '',
    '每个课堂目录包含可编辑 PPTX、Markdown 讲稿、互动页面、音视频/图片素材与完整课堂资源 JSON。',
    'PPTX 的备注页中也保留了对应页面讲稿。',
    payload.sourceFiles.length ? '“原始教学资料”目录保存教师上传或课程关联的原始文件。' : '',
    warnings.length ? `\n未完整下载的项目：\n- ${warnings.join('\n- ')}` : '',
  ].filter(Boolean).join('\n'));

  const archive = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  saveAs(archive, `${safeFileName(payload.course.name, '课程资源')}-完整课程资源.zip`);
}
