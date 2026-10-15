export const redact = text => String(text).replace(/bearer\s+\S+/gi, '[redacted]').replace(/hosty(?:sb|g)[A-Za-z0-9_-]*/g, '[redacted]').replace(/(?:bearer|password|token|code|cookie|authorization)\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 1000);
export function appNavigation(path, target) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20]/.test(path)) throw new Error('sandbox_navigation_invalid');
  const url = new URL(path, target);
  if (url.origin !== target.origin || url.pathname.startsWith('/_hosty/')) throw new Error('sandbox_navigation_invalid');
  return url;
}
