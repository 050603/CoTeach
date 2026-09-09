import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/teacher/settings' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
import { SessionProvider, useSession } from './store';
function Identity() { const session = useSession(); return <span>{session.user.name}</span>; }
afterEach(() => { vi.unstubAllGlobals(); });
it('hydrates the actual settings provider from identity without retired course requests or focus polling', async () => {
  const fetcher = vi.fn(async () => Response.json({ user: { role: 'teacher', displayName: 'V2教师' } }));
  vi.stubGlobal('fetch', fetcher);
  render(<SessionProvider><Identity /></SessionProvider>);
  await waitFor(() => expect(screen.getByText('V2教师')).toBeTruthy());
  await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ headers: { 'X-OpenPBL-Role': 'teacher' } }));
});
