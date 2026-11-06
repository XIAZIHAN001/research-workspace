import type { RestoreRecovery } from './backupService';
import type { workspaceAccess } from './workspaceAccess';

export async function initializeWorkspace(
  mount: (recovery: RestoreRecovery) => void | Promise<void>,
  deps: {
    access: typeof workspaceAccess;
    recover: () => Promise<RestoreRecovery>;
    maintain?: () => Promise<void>;
  },
): Promise<{ status: 'ready' | 'blocked'; detail?: string }> {
  try {
    await deps.access.acquire();
    const recovery = await deps.recover();
    if (recovery === 'blocked') throw new Error('无法确认恢复状态。恢复日志和现有数据均已保留。');
    await deps.maintain?.();
    deps.access.allowWrites();
    await mount(recovery);
    return { status: 'ready' };
  } catch (error) {
    deps.access.block();
    await deps.access.release();
    return {
      status: 'blocked',
      detail: error instanceof Error ? error.message : '恢复状态检查失败。',
    };
  }
}
