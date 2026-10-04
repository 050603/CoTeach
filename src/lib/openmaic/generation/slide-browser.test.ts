import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchSlideBrowser } from './slide-browser';

const { access, launch } = vi.hoisted(() => ({ access: vi.fn(), launch: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access, default: { access } }));
vi.mock('playwright-core', () => ({ chromium: { launch }, default: { chromium: { launch } } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENPBL_CHROMIUM_EXECUTABLE_PATH', '');
  access.mockResolvedValue(undefined);
  launch.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('consistent browser selection for slide measurement and auditing', () => {
  it('uses the default headless shell even when system Chrome is installed', async () => {
    const browser = {};
    launch.mockResolvedValue(browser);
    expect(await launchSlideBrowser()).toBe(browser);
    expect(launch).toHaveBeenCalledExactlyOnceWith({ headless: true });
    expect(access).not.toHaveBeenCalled();
  });

  it('honors an explicitly configured executable before the default', async () => {
    vi.stubEnv('OPENPBL_CHROMIUM_EXECUTABLE_PATH', ' /custom/chromium ');
    launch.mockResolvedValue({});
    await launchSlideBrowser();
    expect(launch).toHaveBeenCalledExactlyOnceWith({ headless: true, executablePath: '/custom/chromium' });
  });

  it('falls back from a failed configured executable to the default before system Chrome', async () => {
    vi.stubEnv('OPENPBL_CHROMIUM_EXECUTABLE_PATH', '/custom/chromium');
    launch.mockRejectedValueOnce(new Error('configured browser cannot launch')).mockResolvedValue({});
    await launchSlideBrowser();
    expect(launch.mock.calls).toEqual([[{ headless: true, executablePath: '/custom/chromium' }], [{ headless: true }]]);
  });

  it('uses available system fallbacks when the bundled browser is unavailable', async () => {
    access.mockImplementation(async (file: string) => {
      if (file !== '/snap/bin/chromium') throw new Error('not installed');
    });
    launch.mockRejectedValueOnce(new Error('bundled browser missing')).mockResolvedValue({});
    await launchSlideBrowser();
    expect(launch.mock.calls).toEqual([[{ headless: true }], [{ headless: true, executablePath: '/snap/bin/chromium' }]]);
  });

  it('preserves the launch failure when no browser works', async () => {
    const failure = new Error('browser unavailable');
    launch.mockRejectedValue(failure);
    access.mockRejectedValue(new Error('not installed'));
    await expect(launchSlideBrowser()).rejects.toBe(failure);
  });
});
