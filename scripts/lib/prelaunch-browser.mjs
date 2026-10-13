import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// The label is evidence, not a User-Agent override. Verify both the installed
// executable and the running browser before giving a run a branded name.
export function browserConfiguration(environment = process.env) {
  const executablePath = environment.PRELAUNCH_E2E_EXECUTABLE_PATH?.trim();
  const label = environment.PRELAUNCH_E2E_BROWSER_LABEL?.trim() || 'chromium';
  assert.ok(['chromium', 'google-chrome', 'microsoft-edge'].includes(label), 'Unsupported browser label');
  assert.ok(label === 'chromium' || executablePath, 'A branded browser label requires its executable path');
  assert.ok(!executablePath || path.isAbsolute(executablePath), 'Browser executable path must be absolute');
  return { label, executablePath };
}

export function assertBrowserIdentity(configuration, runtime, executableVersion = '') {
  const major = runtime.version.split('.')[0];
  assert.match(runtime.userAgent, new RegExp(`(?:Headless)?Chrome/${major}\\.`), 'Runtime Chromium version does not match its User-Agent');
  if (configuration.label === 'google-chrome') {
    assert.match(executableVersion, /^Google Chrome\b/, 'Executable is not Google Chrome');
    assert.doesNotMatch(runtime.userAgent, /Edg\//, 'Microsoft Edge cannot be reported as Google Chrome');
  }
  if (configuration.label === 'microsoft-edge') {
    assert.match(executableVersion, /^Microsoft Edge\b/, 'Executable is not Microsoft Edge');
    assert.match(runtime.userAgent, new RegExp(`Edg/${major}\\.`), 'Runtime is not the requested Microsoft Edge');
  }
  return { label: configuration.label, executablePath: configuration.executablePath ?? null, executableVersion, ...runtime };
}

export async function inspectBrowserIdentity(configuration, context) {
  const executableVersion = configuration.executablePath
    ? execFileSync(configuration.executablePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    : '';
  const page = await context.newPage();
  try {
    const runtime = await page.evaluate(() => ({ userAgent: navigator.userAgent, platform: navigator.platform }));
    return assertBrowserIdentity(configuration, { version: context.browser().version(), ...runtime }, executableVersion);
  } finally { await page.close(); }
}
