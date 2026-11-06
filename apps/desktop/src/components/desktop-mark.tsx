export function DesktopMark({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="desktop-mark">
    <path d="M10 10h22v22h-22Z M68 10h22v22h-22Z M10 39h22v22h-22Z M68 39h22v22h-22Z M10 68h22v22h-22Z M39 68h22v22h-22Z M68 68h22v22h-22Z" fill="currentColor" />
    <path d="M39 39h22v22H39Z" fill="#34D399" />
  </svg>;
}
