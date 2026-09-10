// Match the navigation's 20px icon slot. The artwork stays 24px for optical alignment;
// its internal whitespace keeps the visible mark aligned with the icons below.
export function BrandMark() {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <svg
        viewBox="0 0 100 100"
        aria-hidden
        className="size-6 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M25 36 V64 M75 36 V64 M25 50 H39 M61 50 H75" />
        <rect x="17" y="17" width="16" height="16" rx="4.5" />
        <rect x="67" y="17" width="16" height="16" rx="4.5" />
        <rect x="17" y="67" width="16" height="16" rx="4.5" />
        <rect x="67" y="67" width="16" height="16" rx="4.5" />
        <rect x="42" y="42" width="16" height="16" rx="4.5" />
      </svg>
    </span>
  );
}
