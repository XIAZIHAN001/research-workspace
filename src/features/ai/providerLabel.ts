/**
 * How the interface names the model service.
 *
 * The product deliberately does not show a vendor name: the same UI runs against the offline
 * simulator and against whichever online endpoint the desktop shell was configured with. The
 * backend still records the real provider and model for safety, diagnostics and backups; this
 * module only decides what a reader sees.
 */
export function providerModeLabel(online: boolean): string {
  return online ? '在线模型' : '离线模拟';
}

/** Vendor names never reach the interface; neutral local descriptions pass through unchanged. */
const VENDOR_NAME = /deepseek|openai|anthropic|claude|gpt|moonshot|zhipu|bigmodel|gemini/i;

export function providerDisplayLabel(label: string | null | undefined): string {
  const text = (label ?? '').trim();
  if (text === '') return '模型服务';
  return VENDOR_NAME.test(text) ? '在线模型' : text;
}
