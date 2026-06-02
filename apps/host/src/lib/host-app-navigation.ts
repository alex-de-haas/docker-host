import type { HostAppEntry } from '@/types/apps';

export function getSidebarHostApps(apps: HostAppEntry[]) {
  return apps.filter(isSidebarHostApp);
}

function isSidebarHostApp(app: HostAppEntry) {
  return !app.system;
}
