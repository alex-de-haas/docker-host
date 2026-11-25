/** Locate the stock C# compiler in the installed .NET Framework. */
export function resolveWindowsCompiler(systemRoot?: string): Promise<string>;
/** Prepare the Windows Job Object bridge for this provider installation. */
export function prepareWindowsJob(data: string, source?: string): Promise<string>;
