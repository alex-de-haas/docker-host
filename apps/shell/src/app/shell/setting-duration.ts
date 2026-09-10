const durationUnits: Record<string, { label: string; minutes: number }> = {
  h: { label: "hours", minutes: 60 },
  min: { label: "minutes", minutes: 1 },
  day: { label: "days", minutes: 1440 },
};

export function settingUnitLabel(unit?: string | null): string | undefined {
  return unit ? durationUnits[unit]?.label ?? unit : undefined;
}

/** Exact equivalents only; zero and invalid drafts keep their setting-specific semantics. */
export function settingDurationHint(value: string, unit?: string | null): string | null {
  const definition = unit ? durationUnits[unit] : undefined;
  const amount = Number(value);
  if (!definition || !value.trim() || !Number.isFinite(amount) || amount <= 0) return null;
  let minutes = amount * definition.minutes;
  if (!Number.isSafeInteger(minutes) || minutes < 60) return null;
  const parts: string[] = [];
  for (const [size, label] of [[1440, "day"], [60, "hour"], [1, "minute"]] as const) {
    const count = Math.floor(minutes / size);
    if (count) parts.push(`${count} ${label}${count === 1 ? "" : "s"}`);
    minutes %= size;
  }
  const equivalent = parts.join(" ");
  const original = `${amount} ${amount === 1 ? definition.label.slice(0, -1) : definition.label}`;
  return original === equivalent ? null : `${original} = ${equivalent}`;
}
