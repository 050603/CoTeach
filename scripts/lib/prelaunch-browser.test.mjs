import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBrowserIdentity, browserConfiguration } from './prelaunch-browser.mjs';

const chrome = { version: '142.0.1.2', userAgent: 'Mozilla/5.0 HeadlessChrome/142.0.1.2 Safari/537.36', platform: 'Linux x86_64' };
const edge = { ...chrome, userAgent: `${chrome.userAgent} Edg/142.0.1.2` };

test('unbranded runs keep their actual Chromium identity', () => {
  assert.equal(assertBrowserIdentity(browserConfiguration({}), chrome).label, 'chromium');
});
test('branded labels require explicit executable paths', () => {
  assert.throws(() => browserConfiguration({ PRELAUNCH_E2E_BROWSER_LABEL: 'google-chrome' }));
  assert.throws(() => browserConfiguration({ PRELAUNCH_E2E_EXECUTABLE_PATH: 'chrome' }));
});
test('Chrome and Edge need matching executable and runtime identities', () => {
  const google = { label: 'google-chrome', executablePath: '/usr/bin/google-chrome' };
  const microsoft = { label: 'microsoft-edge', executablePath: '/usr/bin/microsoft-edge' };
  assert.equal(assertBrowserIdentity(google, chrome, 'Google Chrome 142.0.1.2').label, google.label);
  assert.equal(assertBrowserIdentity(microsoft, edge, 'Microsoft Edge 142.0.1.2').label, microsoft.label);
  assert.throws(() => assertBrowserIdentity(google, edge, 'Google Chrome 142.0.1.2'));
  assert.throws(() => assertBrowserIdentity(google, chrome, 'Chromium 142.0.1.2'));
  assert.throws(() => assertBrowserIdentity(microsoft, chrome, 'Microsoft Edge 142.0.1.2'));
  assert.throws(() => assertBrowserIdentity(microsoft, { ...edge, version: '143.0.1.2' }, 'Microsoft Edge 143.0.1.2'));
});
