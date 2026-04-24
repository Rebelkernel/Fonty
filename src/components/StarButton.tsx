export function StarButton({
  starred,
  onToggle,
  size = 16,
}: {
  starred: boolean;
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
        starred
          ? "text-amber-300 hover:text-amber-200"
          : "text-[var(--color-text-faint)] hover:text-amber-300"
      }`}
      style={{ width: size, height: size }}
      title={starred ? "Unstar" : "Star"}
      aria-label={starred ? "Unstar" : "Star"}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill={starred ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        className="pointer-events-none"
      >
        <path d="M8 1.5 10 6 14.5 6.5 11 9.5 12 14 8 11.5 4 14 5 9.5 1.5 6.5 6 6z" />
      </svg>
    </button>
  );
}
