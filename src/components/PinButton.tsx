export function PinButton({
  pinned,
  onToggle,
  size = 16,
}: {
  pinned: boolean;
  onToggle: () => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={`inline-flex items-center justify-center shrink-0 cursor-pointer transition-colors ${
        pinned
          ? "text-sky-300 hover:text-sky-200"
          : "text-[var(--color-text-faint)] hover:text-sky-300"
      }`}
      style={{ width: size, height: size }}
      title={pinned ? "Unpin from comparison dock" : "Pin to comparison dock"}
      aria-label={pinned ? "Unpin" : "Pin"}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={pinned ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="pointer-events-none"
      >
        <path d="M10.5 1.5 14.5 5.5 11.5 6.5 11 10 6 5 9.5 4.5z M7 9 2 14 M6 10 10 6" />
      </svg>
    </button>
  );
}
