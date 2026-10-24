import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectsStore, type ProjectsStore } from '../services/projectsStore';
import { loadProjects } from '../services/storage';
import { SCHEMA_VERSION } from '../domain/migrate';
import { composeWelcome, type WelcomeProvider } from '../services/welcome';
import { App } from './App';
import {
  AVATAR_MAX_BYTES,
  AVATAR_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  SIDEBAR_STORAGE_KEY,
  THEME_LEVEL_STORAGE_KEY,
  THEME_STORAGE_KEY,
  THEME_STYLE_STORAGE_KEY,
} from './config';

type User = ReturnType<typeof userEvent.setup>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePref;
  delete document.documentElement.dataset.themeStyle;
  delete document.documentElement.dataset.darkLevel;
  document.documentElement.removeAttribute('style');
});

function setup(options: { store?: ProjectsStore; welcomeProvider?: WelcomeProvider } = {}) {
  // applyAccept off so the app's own file checks can be exercised with a wrong type.
  const user = userEvent.setup({ applyAccept: false });
  const store = options.store ?? createProjectsStore();
  const utils = render(<App store={store} welcomeProvider={options.welcomeProvider} />);
  return { user, store, ...utils };
}

const sidebar = () => screen.getByRole('complementary', { name: '项目导航' });
const projectList = () => within(sidebar()).getByRole('region', { name: '项目' });
const rowButton = (name: string) => within(projectList()).getByRole('button', { name });

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('file input not found');
  return input;
}

function avatarImage(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector<HTMLImageElement>('.avatar-img');
  if (img === null) throw new Error('avatar image not found');
  return img;
}

async function createProject(user: User, title: string) {
  await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
  const dialog = await screen.findByRole('dialog', { name: '新建项目' });
  await user.type(within(dialog).getByLabelText('核心论文标题'), title);
  await user.click(within(dialog).getByRole('button', { name: '创建项目' }));
}

function stubMatchMedia(matches: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** Stores `count` projects named "Paper 0".."Paper N"; a higher index was updated more recently. */
function seedProjects(count: number): void {
  const stamps = Array.from({ length: count }, (_, i) => 1000 + i);
  const projects = stamps.map((stamp, i) => ({
    id: `p${i}`,
    name: `Paper ${i}`,
    corePaperId: `c${i}`,
    relatedPaperIds: [],
    createdAt: stamp,
    updatedAt: stamp,
  }));
  const papers = stamps.map((stamp, i) => ({
    id: `c${i}`,
    title: `Paper ${i}`,
    authors: [],
    createdAt: stamp,
    updatedAt: stamp,
  }));
  window.localStorage.setItem(
    PROJECTS_STORAGE_KEY,
    JSON.stringify({
      version: SCHEMA_VERSION,
      projects,
      papers: Object.fromEntries(papers.map((paper) => [paper.id, paper])),
      selectedId: projects[0]?.id ?? null,
    }),
  );
}

/** A Phase 0 payload, as it sits in the browser of someone who used the earlier build. */
function seedPhase0Project(): void {
  window.localStorage.setItem(
    PROJECTS_STORAGE_KEY,
    JSON.stringify({
      projects: [
        {
          id: 'old-1',
          name: 'Attention Is All You Need',
          corePaper: {
            id: 'paper-1',
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani'],
          },
          relatedPapers: [],
          createdAt: 500,
          updatedAt: 500,
        },
      ],
      selectedId: 'old-1',
    }),
  );
}

describe('home page', () => {
  it('invites the first project when none exists', async () => {
    setup();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      /新建第一个项目，从一篇想读懂的论文开始/,
    );
    const home = screen.getByRole('region', { name: '首页' });
    expect(within(home).getByRole('button', { name: '新建项目' })).toBeInTheDocument();
    expect(within(sidebar()).getByText(/还没有项目/)).toBeInTheDocument();
  });

  it('shows the welcome line from the injected provider', async () => {
    const provider: WelcomeProvider = { greet: () => Promise.resolve('你好，今天读哪一篇？') };
    setup({ welcomeProvider: provider });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '你好，今天读哪一篇？',
    );
  });

  it('falls back to the template text when the provider fails', async () => {
    const provider: WelcomeProvider = { greet: () => Promise.reject(new Error('offline')) };
    setup({ welcomeProvider: provider });
    const expected = composeWelcome({
      hour: new Date().getHours(),
      projectCount: 0,
      current: null,
    });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(expected);
  });

  it('uses the bundled figure until a custom one is stored', () => {
    const { container } = setup();
    expect(avatarImage(container)).toHaveAttribute('src', '/avatar/default.svg');
  });

  it('shows no error or warning on a first visit', async () => {
    setup();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('sets the greeting large and the rest of the line quieter', async () => {
    setup();
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.querySelector('.welcome-lead')).toHaveTextContent(
      /^(夜深了|早上好|中午好|下午好|晚上好)$/,
    );
    expect(heading.querySelector('.welcome-body')).toHaveTextContent('新建第一个项目');
    // The punctuation sits between the two parts, so the line still reads as one sentence.
    expect(heading).toHaveTextContent('。新建第一个项目');
  });

  it('clears the avatar problem when the picker is opened again', async () => {
    const { user, container } = setup();
    await user.upload(fileInput(container), new File(['x'], 'a.gif', { type: 'image/gif' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '更换形象' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('project page', () => {
  it('marks a long title so it can be set smaller', async () => {
    const { user } = setup();
    const title = 'Mastering the game of Go with deep neural networks and tree search';
    await createProject(user, title);
    expect(screen.getByRole('heading', { level: 1, name: title })).toHaveAttribute(
      'data-long',
      'true',
    );
  });

  it('leaves a short title at full size', async () => {
    const { user } = setup();
    await createProject(user, 'ResNet');
    expect(screen.getByRole('heading', { level: 1, name: 'ResNet' })).toHaveAttribute(
      'data-long',
      'false',
    );
  });
});

describe('creating projects', () => {
  it('opens a focused dialog, creates the project and shows its page', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    expect(within(dialog).getByLabelText('核心论文标题')).toHaveFocus();

    await user.type(within(dialog).getByLabelText('核心论文标题'), '  Attention Is All You Need ');
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Attention Is All You Need' }),
    ).toBeInTheDocument();
    expect(rowButton('Attention Is All You Need')).toHaveAttribute('aria-current', 'true');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
    });
    expect(loadProjects().projects.map((p) => p.name)).toStrictEqual(['Attention Is All You Need']);
  });

  it('creates from the keyboard with Enter', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    await user.keyboard('ResNet{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'ResNet' })).toBeInTheDocument();
  });

  it('refuses a blank title and explains why', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    await user.type(within(dialog).getByLabelText('核心论文标题'), '   ');
    await user.click(within(dialog).getByRole('button', { name: '创建项目' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入论文标题');
    expect(within(dialog).getByLabelText('核心论文标题')).toBeInvalid();
    expect(loadProjects().projects).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('核心论文标题'), 'x');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('starts every dialog with an empty form', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const first = await screen.findByRole('dialog', { name: '新建项目' });
    await user.type(within(first).getByLabelText('核心论文标题'), 'draft');
    await user.click(within(first).getByRole('button', { name: '取消' }));
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const second = await screen.findByRole('dialog', { name: '新建项目' });
    expect(within(second).getByLabelText('核心论文标题')).toHaveValue('');
  });

  it('closes the dialog when it is cancelled by the platform', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    const dialog = await screen.findByRole('dialog', { name: '新建项目' });
    // Testing Library has no helper for the dialog's `cancel` event (Escape in a browser).
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
    });
  });
});

describe('selecting and renaming', () => {
  async function twoProjects(user: User) {
    await createProject(user, 'Alpha');
    await createProject(user, 'Beta');
  }

  it('lists projects newest first and switches the project page on click', async () => {
    const { user } = setup();
    await twoProjects(user);

    const names = within(projectList())
      .getAllByRole('listitem')
      .map((item) => item.querySelector('.row-name')?.textContent);
    expect(names).toStrictEqual(['Beta', 'Alpha']);
    expect(rowButton('Beta')).toHaveAttribute('aria-current', 'true');

    await user.click(rowButton('Alpha'));
    expect(screen.getByRole('heading', { level: 1, name: 'Alpha' })).toBeInTheDocument();
    expect(rowButton('Alpha')).toHaveAttribute('aria-current', 'true');
    expect(rowButton('Beta')).not.toHaveAttribute('aria-current');
  });

  it('goes back to the home page from the sidebar', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(sidebar()).getByRole('button', { name: '首页' }));
    expect(screen.getByRole('region', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开《Alpha》' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开《Alpha》' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Alpha' })).toBeInTheDocument();
  });

  it('renames in place with Enter and persists the new name', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(projectList()).getByRole('button', { name: '重命名 Alpha' }));
    const input = screen.getByRole('textbox', { name: '重命名项目 Alpha' });
    expect(input).toHaveFocus();
    await user.keyboard('Gamma{Enter}');

    expect(rowButton('Gamma')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Gamma' })).toBeInTheDocument();
    expect(loadProjects().projects[0]?.name).toBe('Gamma');
  });

  it('renames on double click and commits on blur', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.dblClick(rowButton('Alpha'));
    await user.keyboard('Delta');
    await user.tab();
    expect(rowButton('Delta')).toBeInTheDocument();
  });

  it('renames from the keyboard with F2', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    rowButton('Alpha').focus();
    await user.keyboard('{F2}Epsilon{Enter}');
    expect(rowButton('Epsilon')).toBeInTheDocument();
  });

  it('cancels a rename with Escape and leaves the name alone', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(projectList()).getByRole('button', { name: '重命名 Alpha' }));
    await user.keyboard('Zeta{Escape}');
    expect(rowButton('Alpha')).toBeInTheDocument();
    expect(loadProjects().projects[0]?.name).toBe('Alpha');
  });

  it('keeps the old name when the new one is blank', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(projectList()).getByRole('button', { name: '重命名 Alpha' }));
    await user.keyboard('{Control>}a{/Control}{Backspace}{Enter}');
    expect(rowButton('Alpha')).toBeInTheDocument();
  });
});

describe('deleting projects', () => {
  it('asks first, with Cancel focused, and keeps the project when cancelled', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(projectList()).getByRole('button', { name: '删除 Alpha' }));
    const dialog = await screen.findByRole('dialog', { name: '删除项目' });
    expect(within(dialog).getByText(/《Alpha》/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '删除项目' })).not.toBeInTheDocument();
    });
    expect(rowButton('Alpha')).toBeInTheDocument();
  });

  it('removes the project on confirm and returns to the home page', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await user.click(within(projectList()).getByRole('button', { name: '删除 Alpha' }));
    const dialog = await screen.findByRole('dialog', { name: '删除项目' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(screen.getByRole('region', { name: '首页' })).toBeInTheDocument();
    expect(within(sidebar()).getByText(/还没有项目/)).toBeInTheDocument();
    expect(loadProjects().projects).toHaveLength(0);
  });

  it('stays on the open project when a different one is deleted', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    await createProject(user, 'Beta');
    await user.click(rowButton('Alpha'));

    await user.click(within(projectList()).getByRole('button', { name: '删除 Beta' }));
    const dialog = await screen.findByRole('dialog', { name: '删除项目' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Alpha' })).toBeInTheDocument();
    expect(within(projectList()).queryByRole('button', { name: 'Beta' })).not.toBeInTheDocument();
  });

  it('shows the management actions on every row while 管理项目 is on', async () => {
    const { user } = setup();
    await createProject(user, 'Alpha');
    const list = within(sidebar()).getByRole('list', { name: '' });
    expect(list).toHaveAttribute('data-managing', 'false');
    await user.click(within(sidebar()).getByRole('button', { name: '管理项目' }));
    expect(list).toHaveAttribute('data-managing', 'true');
    expect(within(sidebar()).getByRole('button', { name: '管理项目' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('theme', () => {
  const levelSlider = () => screen.getByRole('slider', { name: '深色程度' });

  /** The theme controls live in Settings › Appearance, not on the first-level page. */
  async function openSettings() {
    const result = setup();
    await result.user.click(screen.getByRole('button', { name: '设置' }));
    await screen.findByRole('dialog', { name: '设置' });
    return result;
  }

  it('applies and persists an explicit choice', async () => {
    const { user } = await openSettings();
    await user.click(screen.getByRole('button', { name: '深色' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-theme-pref', 'dark');
    expect(document.documentElement).toHaveAttribute('data-dark-level', '100');
    expect(document.documentElement).toHaveAttribute('data-theme-style', 'obsidian');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(window.localStorage.getItem(THEME_LEVEL_STORAGE_KEY)).toBe('100');
    expect(screen.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '浅色' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: '浅色' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).toHaveAttribute('data-dark-level', '100');
  });

  it('starts at pure black and lets the level change the whole dark ladder', async () => {
    await openSettings();
    expect(levelSlider()).toHaveValue('100');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#000000');

    fireEvent.change(levelSlider(), { target: { value: '50' } });
    expect(levelSlider()).toHaveValue('50');
    expect(document.documentElement).toHaveAttribute('data-dark-level', '50');
    expect(document.documentElement).toHaveAttribute('data-theme-style', 'graphite');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#121212');
    expect(document.documentElement.style.getPropertyValue('--dark-panel')).toBe('#1f1f1f');
    expect(window.localStorage.getItem(THEME_LEVEL_STORAGE_KEY)).toBe('50');

    fireEvent.change(levelSlider(), { target: { value: '0' } });
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#242424');
    expect(window.localStorage.getItem(THEME_LEVEL_STORAGE_KEY)).toBe('0');

    fireEvent.change(levelSlider(), { target: { value: '100' } });
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#000000');
    expect(document.documentElement).toHaveAttribute('data-theme-style', 'obsidian');
  });

  it('keeps exactly the last level after rapid changes', async () => {
    await openSettings();
    for (const level of ['10', '90', '0', '75', '100']) {
      fireEvent.change(levelSlider(), { target: { value: level } });
    }
    expect(levelSlider()).toHaveValue('100');
    expect(document.documentElement).toHaveAttribute('data-dark-level', '100');
    expect(window.localStorage.getItem(THEME_LEVEL_STORAGE_KEY)).toBe('100');
  });

  it('restores the stored level on the next start', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.localStorage.setItem(THEME_LEVEL_STORAGE_KEY, '25');
    await openSettings();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-dark-level', '25');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#1b1b1b');
    expect(levelSlider()).toHaveValue('25');
    expect(screen.getByRole('button', { name: '深色' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('restores a saved OLED palette from a Phase 12 profile as pure black', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.localStorage.setItem(THEME_STYLE_STORAGE_KEY, 'obsidian');
    await openSettings();
    expect(document.documentElement).toHaveAttribute('data-dark-level', '100');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#000000');
    expect(levelSlider()).toHaveValue('100');
  });

  it('maps a saved Graphite profile to the equivalent neutral grey', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.localStorage.setItem(THEME_STYLE_STORAGE_KEY, 'graphite');
    await openSettings();
    expect(document.documentElement).toHaveAttribute('data-dark-level', '36');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#171717');
    expect(levelSlider()).toHaveValue('36');
  });

  it('a stored level wins over a legacy palette name', async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    window.localStorage.setItem(THEME_STYLE_STORAGE_KEY, 'obsidian');
    window.localStorage.setItem(THEME_LEVEL_STORAGE_KEY, '40');
    await openSettings();
    expect(document.documentElement).toHaveAttribute('data-dark-level', '40');
    expect(document.documentElement).toHaveAttribute('data-theme-style', 'graphite');
    expect(levelSlider()).toHaveValue('40');
  });

  it('follows the system scheme and applies the saved level when it turns dark', async () => {
    window.localStorage.setItem(THEME_LEVEL_STORAGE_KEY, '0');
    stubMatchMedia((query) => query.includes('prefers-color-scheme: dark'));
    await openSettings();
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-theme-pref', 'system');
    expect(document.documentElement.style.getPropertyValue('--dark-app')).toBe('#242424');
    expect(levelSlider()).toHaveValue('0');
    expect(screen.getByRole('button', { name: '跟随系统' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('settings', () => {
  it('keeps theme controls out of the first-level page and the avatar in the sidebar', async () => {
    const { user, container } = setup();
    expect(sidebar().querySelector('.avatar-img')).toBeInTheDocument();
    expect(container.querySelector('.home .avatar-img')).toBeNull();
    expect(screen.queryByRole('slider', { name: '深色程度' })).toBeNull();

    await user.click(within(sidebar()).getByRole('button', { name: '设置' }));
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    const settings = within(dialog).getByRole('region', { name: '设置' });
    expect(within(settings).getByRole('group', { name: '主题' })).toBeInTheDocument();
    expect(within(settings).getByRole('slider', { name: '深色程度' })).toBeInTheDocument();
  });

  it('shows the AI service inside settings without a provider name', async () => {
    const { user } = setup();
    await user.click(within(sidebar()).getByRole('button', { name: '设置' }));
    const dialog = await screen.findByRole('dialog', { name: '设置' });
    const settings = within(dialog).getByRole('region', { name: '设置' });
    await user.click(within(settings).getByRole('button', { name: 'AI 服务' }));
    expect(within(settings).getByText(/这些设置只在桌面应用中可用/)).toBeInTheDocument();
    expect(within(settings).queryByText(/deepseek/i)).not.toBeInTheDocument();
    // It is a settings window, not a first-level page or the old AI-only dialog.
    expect(dialog).toHaveAttribute('open');
  });
});

describe('sidebar', () => {
  it('collapses, offers a way back, and keeps the choice for the session', async () => {
    const { user, container } = setup();
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'open');

    await user.click(screen.getByRole('button', { name: '收起侧栏' }));
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'closed');
    // Startup open/closed is owned by the layout preset now; the in-session toggle is not
    // written back behind the user's back — "恢复默认布局" and the preset page own storage.
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
    // The column stays mounted so it can animate, but it must be inert: no focus, no clicks.
    expect(sidebar()).toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'open');
    expect(sidebar()).not.toHaveAttribute('inert');
  });

  it('starts collapsed when the profile was migrated from a closed sidebar', () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'closed');
    const { container } = setup();
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'closed');
    expect(screen.getByRole('button', { name: '展开侧栏' })).toBeInTheDocument();
  });

  it('opens as a dismissible overlay in a narrow window without saving that state', async () => {
    stubMatchMedia((query) => query.includes('max-width'));
    const { user, container } = setup();
    expect(container.querySelector('.app')).toHaveAttribute('data-narrow', 'true');
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'closed');

    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'open');
    expect(screen.getByRole('button', { name: '关闭侧栏' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'closed');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it('closes the narrow overlay after a project is chosen', async () => {
    stubMatchMedia((query) => query.includes('max-width'));
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    await createProject(user, 'Alpha');
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'closed');
    expect(screen.getByRole('heading', { level: 1, name: 'Alpha' })).toBeInTheDocument();
  });

  it('keeps the narrow overlay open when Escape only dismisses a dialog', async () => {
    stubMatchMedia((query) => query.includes('max-width'));
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    await user.click(within(sidebar()).getByRole('button', { name: '新建项目' }));
    await screen.findByRole('dialog', { name: '新建项目' });

    await user.keyboard('{Escape}');

    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'open');
  });

  it('cancels a rename with Escape without closing the narrow overlay', async () => {
    seedProjects(1);
    stubMatchMedia((query) => query.includes('max-width'));
    const { user, container } = setup();
    await user.click(screen.getByRole('button', { name: '展开侧栏' }));
    await user.click(within(projectList()).getByRole('button', { name: '重命名 Paper 0' }));

    await user.keyboard('x{Escape}');

    expect(rowButton('Paper 0')).toBeInTheDocument();
    expect(container.querySelector('.app')).toHaveAttribute('data-sidebar', 'open');
  });

  it('offers the recent list only once the project list is long', () => {
    seedProjects(5);
    const first = setup();
    expect(within(sidebar()).queryByRole('region', { name: '最近更新' })).not.toBeInTheDocument();
    first.unmount();

    seedProjects(6);
    setup();
    const recent = within(sidebar()).getByRole('region', { name: '最近更新' });
    const titles = within(recent)
      .getAllByRole('button')
      .map((button) => button.getAttribute('title'));
    expect(titles).toStrictEqual(['Paper 5', 'Paper 4', 'Paper 3']);
  });
});

describe('avatar', () => {
  it('stores a chosen image and shows it', async () => {
    const { user, container } = setup();
    const file = new File(['abc'], 'me.png', { type: 'image/png' });
    await user.upload(fileInput(container), file);

    await waitFor(() => {
      expect(avatarImage(container)).toHaveAttribute('src', 'data:image/png;base64,YWJj');
    });
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBe('data:image/png;base64,YWJj');
    expect(screen.getByRole('button', { name: '恢复默认形象' })).toBeInTheDocument();
  });

  it('restores the default figure', async () => {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, 'data:image/png;base64,YWJj');
    const { user, container } = setup();
    expect(avatarImage(container)).toHaveAttribute('src', 'data:image/png;base64,YWJj');
    await user.click(screen.getByRole('button', { name: '恢复默认形象' }));
    expect(avatarImage(container)).toHaveAttribute('src', '/avatar/default.svg');
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('rejects an unsupported type and keeps the current figure', async () => {
    const { user, container } = setup();
    await user.upload(fileInput(container), new File(['x'], 'a.gif', { type: 'image/gif' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PNG、JPEG、WebP 或 SVG');
    expect(avatarImage(container)).toHaveAttribute('src', '/avatar/default.svg');
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });

  it('rejects an oversized image', async () => {
    const { user, container } = setup();
    const big = new File([new Uint8Array(AVATAR_MAX_BYTES + 1)], 'big.png', { type: 'image/png' });
    await user.upload(fileInput(container), big);
    expect(await screen.findByRole('alert')).toHaveTextContent('1 MB');
  });

  it('rejects an empty image and keeps the current figure', async () => {
    const { user, container } = setup();
    await user.upload(fileInput(container), new File([], 'empty.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('空');
    expect(avatarImage(container)).toHaveAttribute('src', '/avatar/default.svg');
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBeNull();
  });
});

describe('persistence warning', () => {
  it('tells the user when changes cannot be saved', async () => {
    const { user } = setup({ store: createProjectsStore(null) });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await createProject(user, 'Alpha');
    expect(await screen.findByRole('status')).toHaveTextContent('没有保存');
  });
});

describe('data written by the earlier build', () => {
  const storedPayload = (): Record<string, unknown> =>
    JSON.parse(window.localStorage.getItem(PROJECTS_STORAGE_KEY) ?? 'null') as Record<
      string,
      unknown
    >;

  it('upgrades the stored payload and shows the project it held', async () => {
    seedPhase0Project();
    const { user } = setup();

    expect(rowButton('Attention Is All You Need')).toBeInTheDocument();
    const stored = storedPayload();
    expect(stored.version).toBe(SCHEMA_VERSION);
    expect(stored.projects).toStrictEqual([
      {
        id: 'old-1',
        name: 'Attention Is All You Need',
        corePaperId: 'paper-1',
        relatedPaperIds: [],
        createdAt: 500,
        updatedAt: 500,
      },
    ]);
    expect(stored.papers).toStrictEqual({
      'paper-1': {
        id: 'paper-1',
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani'],
        createdAt: 500,
        updatedAt: 500,
      },
    });

    await user.click(rowButton('Attention Is All You Need'));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Attention Is All You Need' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Vaswani')).toBeInTheDocument();
  });

  it('keeps the migrated project when a new one is created on top of it', async () => {
    seedPhase0Project();
    const { user } = setup();
    await createProject(user, 'BERT');

    const stored = storedPayload();
    expect((stored.projects as { name: string }[]).map((p) => p.name)).toStrictEqual([
      'BERT',
      'Attention Is All You Need',
    ]);
    expect(Object.keys(stored.papers as Record<string, unknown>)).toHaveLength(2);
  });
});

describe('notice when stored data cannot be loaded', () => {
  const CORRUPT_TEXT = /本地保存的项目数据已损坏/;
  const NEWER_TEXT = /更新版本的应用写入/;

  it('says the original was set aside rather than deleted', () => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, '{oops');
    setup();

    const notice = screen.getByText(CORRUPT_TEXT);
    expect(notice.textContent).toContain('没有被删除');
    expect(notice.textContent).toContain('rw.projects.corrupt');
    expect(screen.getByText(/请不要清理浏览器数据/)).toBeInTheDocument();
  });

  it('shows no raw payload and no internal error text', () => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, '{oops');
    const { container } = setup();

    expect(container.textContent).not.toContain('{oops');
    expect(container.textContent).not.toMatch(/SyntaxError|Unexpected token|Unexpected end/);
  });

  it('explains a payload written by a newer version, and where its copy is', () => {
    window.localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify({ version: 99, projects: [], papers: {}, selectedId: null }),
    );
    setup();

    const notice = screen.getByText(NEWER_TEXT);
    expect(notice.textContent).toContain('rw.projects.backup');
    expect(notice.textContent).toContain('没有被覆盖或删除');
  });

  it('starts from an empty workspace the user can still use', async () => {
    window.localStorage.setItem(PROJECTS_STORAGE_KEY, '{oops');
    const { user } = setup();

    expect(screen.getByText(/还没有项目/)).toBeInTheDocument();
    await createProject(user, 'BERT');
    expect(await screen.findByRole('heading', { level: 1, name: 'BERT' })).toBeInTheDocument();
    // The unreadable payload is still quarantined, and the new project was saved normally.
    expect(window.localStorage.getItem(`${PROJECTS_STORAGE_KEY}.corrupt`)).toBe('{oops');
    expect(loadProjects().projects.map((p) => p.name)).toStrictEqual(['BERT']);
  });

  it('says nothing when the stored payload loads normally', () => {
    seedProjects(2);
    setup();

    expect(screen.queryByText(CORRUPT_TEXT)).toBeNull();
    expect(screen.queryByText(NEWER_TEXT)).toBeNull();
  });

  it('says nothing after a normal upgrade from the earlier shape', () => {
    seedPhase0Project();
    setup();

    expect(screen.queryByText(CORRUPT_TEXT)).toBeNull();
    expect(screen.queryByText(NEWER_TEXT)).toBeNull();
    expect(rowButton('Attention Is All You Need')).toBeInTheDocument();
  });
});
