import { access } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright-core';

/** Match the actual slide renderer's browser selection. A system Chrome and
 * Playwright's default headless shell can select different fallback glyphs,
 * even with the same CSS and font family, changing measured collisions. */
export async function launchSlideBrowser(): Promise<Browser> {
  const configured = process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = [...new Set([configured || undefined, undefined,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'])];
  let lastError: unknown;
  for (const executablePath of candidates) {
    if (executablePath) {
      try { await access(executablePath); } catch { continue; }
    }
    try {
      return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Chromium executable is available');
}
