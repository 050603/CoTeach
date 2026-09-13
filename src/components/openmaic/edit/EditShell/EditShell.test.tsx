import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';
import type { SurfaceState } from '@openmaic/lib/edit/scene-editor-surface';

const mocks = vi.hoisted(() => ({
  undo: vi.fn(),
  redo: vi.fn(),
  command: vi.fn(),
  navigate: vi.fn(),
  setCurrentSceneId: vi.fn(),
  surfaceState: null as SurfaceState | null,
  scenes: [{ id: 'slide-1', stageId: 'stage-1', type: 'slide', title: '页面一', order: 1 }] as Scene[],
  narrow: false,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.navigate }) }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@openmaic/lib/store', () => ({
  useStageStore: {
    use: {
      scenes: () => mocks.scenes,
      currentSceneId: () => 'slide-1',
      setCurrentSceneId: () => mocks.setCurrentSceneId,
      setScenes: () => vi.fn(),
      insertSceneAfter: () => vi.fn(),
      deleteScene: () => vi.fn(),
      stage: () => ({ id: 'stage-1' }),
    },
  },
}));
vi.mock('@openmaic/lib/store/settings', async () => {
  const { create } = await import('zustand');
  interface Settings {
    editRailCollapsed: boolean;
    editRailWidth: number;
    setEditRailCollapsed: (collapsed: boolean) => void;
    setEditRailWidth: (width: number) => void;
  }
  return {
    useSettingsStore: create<Settings>((set) => ({
      editRailCollapsed: false,
      editRailWidth: 220,
      setEditRailCollapsed: (editRailCollapsed) => set({ editRailCollapsed }),
      setEditRailWidth: (editRailWidth) => set({ editRailWidth }),
    })),
  };
});
vi.mock('@openmaic/lib/edit/scene-editor-registry', () => ({
  sceneEditorRegistry: {
    resolve: () => ({
      sceneType: 'slide',
      SurfaceComponent: () => <div>页面画布</div>,
      useSurfaceState: () => mocks.surfaceState,
    }),
  },
}));
vi.mock('@openmaic/lib/edit/noop-surface', () => ({ NOOP_SURFACE: {} }));
vi.mock('@openmaic/lib/edit/slide-defaults', () => ({
  createBlankSlideScene: vi.fn(),
  duplicateScene: vi.fn(),
}));
vi.mock('../SlideNavRail/ThumbItem', () => ({
  ThumbItem: ({ scene, onActivate }: { scene: Scene; onActivate: () => void }) => (
    <li><button onClick={onActivate}>{scene.title}</button></li>
  ),
}));
vi.mock('./FloatingInsertToolbar', () => ({ FloatingInsertToolbar: () => null }));
vi.mock('./FloatingToolbar', () => ({ FloatingToolbar: () => null }));

import { useSettingsStore } from '@openmaic/lib/store/settings';
import { EditShell } from './EditShell';
import { SlideNavRail } from '../SlideNavRail';

function TeacherEditor({ scene = mocks.scenes[0] }: { scene?: Scene }) {
  return (
    <EditShell
      scene={scene}
      commandPlacement="navigation"
      leftRail={(controls) => <SlideNavRail editorControls={controls} brand={{ src: '/brand.png', iconSrc: '/brand-icon.png', alt: 'PrAIxis' }} />}
    />
  );
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
  useSettingsStore.setState({ editRailCollapsed: false, editRailWidth: 220 });
  mocks.surfaceState = {
    content: {} as SurfaceState['content'],
    selection: undefined,
    hasSelection: false,
    history: { canUndo: true, canRedo: false, undo: mocks.undo, redo: mocks.redo },
    commands: [{ id: 'export', label: '导出页面', onInvoke: mocks.command }],
    insertItems: [],
    floatingActions: [],
  };
});

describe('teacher editor chrome', () => {
  it('moves page actions into the navigator and keeps them working after collapse', () => {
    render(<TeacherEditor />);
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'generation.backToHome' })).not.toBeInTheDocument();
    expect(screen.getByText('页面画布')).toBeInTheDocument();

    const rail = within(screen.getByTestId('slide-nav-rail'));
    expect(rail.getByRole('img', { name: 'PrAIxis' })).toHaveAttribute('src', '/brand.png');
    fireEvent.click(rail.getByRole('button', { name: 'edit.undo' }));
    expect(mocks.undo).toHaveBeenCalledOnce();
    expect(rail.getByRole('button', { name: 'edit.redo' })).toBeDisabled();
    fireEvent.click(rail.getByRole('button', { name: '导出页面' }));
    expect(mocks.command).toHaveBeenCalledOnce();

    fireEvent.click(rail.getByRole('button', { name: 'edit.nav.collapse' }));
    expect(rail.getByRole('img', { name: 'PrAIxis' })).toHaveAttribute('src', '/brand-icon.png');
    fireEvent.click(rail.getByRole('button', { name: 'edit.undo' }));
    expect(mocks.undo).toHaveBeenCalledTimes(2);
    expect(rail.getByRole('button', { name: '页面一' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the logo instead of a page title when the current surface changes', async () => {
    const view = render(<TeacherEditor />);
    mocks.surfaceState = { ...mocks.surfaceState!, history: undefined, commands: [] };
    view.rerender(<TeacherEditor scene={{ ...mocks.scenes[0], title: '阅读说明', type: 'interactive' } as Scene} />);

    await waitFor(() => expect(within(screen.getByTestId('slide-nav-rail')).queryByText('阅读说明')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('slide-nav-rail')).getByRole('img', { name: 'PrAIxis' })).toHaveAttribute('src', '/brand.png');
    expect(screen.queryByRole('button', { name: 'edit.undo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导出页面' })).not.toBeInTheDocument();
  });

  it('opens mobile page navigation over the canvas and closes it after page selection', () => {
    mocks.narrow = true;
    render(<TeacherEditor />);
    const rail = screen.getByTestId('slide-nav-rail');
    expect(rail).toHaveAttribute('data-collapsed', 'true');
    const reservedWidth = rail.parentElement!.style.width;
    fireEvent.click(screen.getByRole('button', { name: 'edit.nav.expand' }));
    expect(rail).toHaveAttribute('data-collapsed', 'false');
    expect(rail.parentElement!.style.width).toBe(reservedWidth);
    fireEvent.click(within(rail).getByRole('button', { name: '页面一' }));
    expect(rail).toHaveAttribute('data-collapsed', 'true');
  });

  it('retains the shared editor top bar and home navigation outside teacher preparation', async () => {
    render(<EditShell scene={mocks.scenes[0]} commandTrailing={<button>编辑模式</button>} />);
    const header = within(screen.getByRole('banner'));
    await waitFor(() => expect(header.getByText('页面一')).toBeVisible());
    fireEvent.click(header.getByRole('button', { name: 'generation.backToHome' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/');
    expect(header.getByRole('button', { name: '编辑模式' })).toBeVisible();
  });

  it('does not let teacher branding bypass the protected return action', () => {
    render(<SlideNavRail brand={{ src: '/brand.png', alt: 'PrAIxis' }} />);
    const brand = screen.getByRole('img', { name: 'PrAIxis' });
    fireEvent.click(brand);
    expect(brand.closest('button')).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
