export function ColorSwatch({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (c: string) => void;
  label: string;
}) {
  return (
    <label
      className="relative inline-block w-5 h-5 rounded border border-[var(--color-border)] cursor-pointer overflow-hidden"
      style={{ backgroundColor: value }}
      title={`${label} (${value})`}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        aria-label={label}
      />
    </label>
  );
}
