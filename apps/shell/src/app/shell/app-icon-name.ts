// Lucide component names (BarChart, ChartNoAxesColumnIncreasing, ChartBar3) and dynamic
// import keys differ only in word separators and case. Keep the library's exact key as the result.
export function createAppIconNameResolver<T extends string>(names: readonly T[]) {
  const normalize = (name: string) => name.replace(/[-_\s]/g, "").toLowerCase();
  const exact = new Set<string>(names);
  const normalized = new Map(names.map(name => [normalize(name), name]));
  return (name?: string | null): T | null => {
    const value = name?.trim();
    if (!value) return null;
    return exact.has(value) ? value as T : normalized.get(normalize(value)) ?? null;
  };
}
