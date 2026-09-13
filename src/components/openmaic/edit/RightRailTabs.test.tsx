import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRuntime } from '@assistant-ui/react';

const mocks = vi.hoisted(() => ({ unmount: vi.fn(), narrow: false }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openmaic/components/edit/AgentPanel/AgentPanel', async () => {
  const { useEffect } = await import('react');
  return {
    AgentPanel: () => {
      useEffect(() => () => mocks.unmount(), []);
      return <textarea aria-label="编辑要求" />;
    },
  };
});
vi.mock('@openmaic/components/edit/AgentsView/AgentRosterPanel', () => ({
  AgentRosterPanel: () => <div>课堂角色列表</div>,
}));

import { RightRailTabs, type RightRailTabsProps } from './RightRailTabs';

function props(): RightRailTabsProps {
  return {
    runtime: {} as AssistantRuntime,
    clearThread: vi.fn(),
    hasMessages: false,
    canSend: true,
    agentEnabled: true,
    isRunning: false,
    sessions: [],
    activeSessionId: undefined,
    switchSession: vi.fn(),
    deleteSessionAndRefresh: vi.fn(),
    refreshSessions: vi.fn(),
    aiOnly: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.narrow = false;
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({
    matches: mocks.narrow,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  }));
});

describe('AI editor rail', () => {
  it('retains an unsent editing request when the teacher collapses and reopens it', () => {
    render(<RightRailTabs {...props()} />);
    fireEvent.change(screen.getByRole('textbox', { name: '编辑要求' }), { target: { value: '请增加一个对比表格' } });
    fireEvent.click(screen.getByRole('button', { name: 'edit.agent.collapse' }));
    expect(screen.queryByRole('textbox', { name: '编辑要求' })).not.toBeInTheDocument();
    expect(mocks.unmount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'edit.agent.expand' }));
    expect(screen.getByRole('textbox', { name: '编辑要求' })).toHaveValue('请增加一个对比表格');
  });

  it('defaults to a collapsed narrow rail and opens AI requests without reducing canvas width', () => {
    mocks.narrow = true;
    const railProps = props();
    const view = render(<RightRailTabs {...railProps} openSignal={0} />);
    const rail = screen.getByTestId('right-rail');
    expect(rail).toHaveAttribute('data-collapsed', 'true');
    const reservedWidth = rail.style.width;
    view.rerender(<RightRailTabs {...railProps} openSignal={1} />);
    expect(rail).toHaveAttribute('data-collapsed', 'false');
    expect(rail.style.width).toBe(reservedWidth);
    expect(screen.getByRole('textbox', { name: '编辑要求' })).toBeVisible();
    fireEvent.keyDown(screen.getByRole('textbox', { name: '编辑要求' }), { key: 'Escape' });
    expect(rail).toHaveAttribute('data-collapsed', 'true');
  });

  it('collapses after a narrow viewport change while keeping the draft mounted', () => {
    const railProps = props();
    const view = render(<RightRailTabs {...railProps} />);
    fireEvent.change(screen.getByRole('textbox', { name: '编辑要求' }), { target: { value: '补充图片' } });
    mocks.narrow = true;
    view.rerender(<RightRailTabs {...railProps} />);
    expect(screen.getByTestId('right-rail')).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'edit.agent.expand' }));
    expect(screen.getByRole('textbox', { name: '编辑要求' })).toHaveValue('补充图片');
  });

  it('keeps the shared editor roster reachable when a scene has no AI editing support', () => {
    render(<RightRailTabs {...props()} aiOnly={false} agentEnabled={false} canSend={false} />);
    expect(screen.getByRole('tab', { name: '课堂阵容' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('课堂角色列表')).toBeVisible();
  });
});
