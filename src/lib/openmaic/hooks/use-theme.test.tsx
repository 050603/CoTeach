import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './use-theme';

function ThemeControl() {
  const { resolvedTheme, setTheme } = useTheme();
  return <button onClick={() => setTheme('dark')}>{resolvedTheme}</button>;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove('dark');
});

describe('classroom theme with restricted browser storage', () => {
  it('renders the classroom when preference reads are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'light' })).toBeVisible();
  });

  it('keeps theme controls working when preference writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'QuotaExceededError'); });
    render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'dark' })).toBeVisible();
    expect(document.documentElement).toHaveClass('dark');
  });
});
