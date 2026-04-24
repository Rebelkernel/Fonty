import { useEffect, useMemo } from "react";
import { useStore } from "../store";
import type { FamilySummary, FontRow } from "../types";
import { FontPreview } from "./FontPreview";
import { PinButton } from "./PinButton";

function GoogleFontHead({ family }: { family: string }) {
  // Inject the Google CSS <link> while the pinned row is visible so the
  // preview renders. Ref-counted via setAttribute so duplicates collapse.
  useEffect(() => {
    const existing = document.head.querySelector(
      `link[data-pinned-google="${CSS.escape(family)}"]`,
    );
    if (existing) {
      existing.setAttribute(
        "data-refcount",
        String(
          (parseInt(existing.getAttribute("data-refcount") ?? "0", 10) || 0) + 1,
        ),
      );
      return () => {
        const n =
          parseInt(existing.getAttribute("data-refcount") ?? "0", 10) || 0;
        if (n <= 1) existing.remove();
        else existing.setAttribute("data-refcount", String(n - 1));
      };
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
      family,
    )}&display=block`;
    link.setAttribute("data-pinned-google", family);
    link.setAttribute("data-refcount", "1");
    document.head.appendChild(link);
    return () => {
      const n = parseInt(link.getAttribute("data-refcount") ?? "0", 10) || 0;
      if (n <= 1) link.remove();
      else link.setAttribute("data-refcount", String(n - 1));
    };
  }, [family]);
  return <span className="truncate">{family}</span>;
}

export function PinnedDock() {
  const pinnedNames = useStore((s) => s.pinnedFamilyNames);
  const pinnedStyles = useStore((s) => s.pinnedStyles);
  const pinnedGoogleFamilies = useStore((s) => s.pinnedGoogleFamilies);
  const pinnedGoogleVariants = useStore((s) => s.pinnedGoogleVariants);
  const families = useStore((s) => s.families);
  const togglePin = useStore((s) => s.togglePin);
  const togglePinStyle = useStore((s) => s.togglePinStyle);
  const togglePinGoogleFamily = useStore((s) => s.togglePinGoogleFamily);
  const togglePinGoogleVariant = useStore((s) => s.togglePinGoogleVariant);
  const clearPins = useStore((s) => s.clearPins);
  const openFamily = useStore((s) => s.openFamily);
  const openGoogleFamily = useStore((s) => s.openGoogleFamily);
  const previewText = useStore((s) => s.previewText);
  const previewSize = useStore((s) => s.previewSize);
  const previewTextColor = useStore((s) => s.previewTextColor);
  const previewBgColor = useStore((s) => s.previewBgColor);

  const pinnedFamilies = useMemo(() => {
    const byName = new Map(families.map((f) => [f.familyName, f]));
    return pinnedNames
      .map((n) => byName.get(n))
      .filter((f): f is FamilySummary => Boolean(f));
  }, [pinnedNames, families]);

  const totalPinned =
    pinnedFamilies.length +
    pinnedStyles.length +
    pinnedGoogleFamilies.length +
    pinnedGoogleVariants.length;
  if (totalPinned === 0) return null;

  return (
    <div
      className="shrink-0 flex flex-col max-h-[45%] overflow-hidden rounded-3xl transition-colors"
      style={{
        backgroundColor: previewBgColor,
        color: previewTextColor,
      }}
    >
      <div
        className="px-5 py-2 flex items-center justify-between shrink-0"
        style={{ borderBottom: "1px solid rgba(128,128,128,0.15)" }}
      >
        <div
          className="text-[10px] uppercase tracking-wider"
          style={{ opacity: 0.5 }}
        >
          Pinned for comparison · {totalPinned}
        </div>
        <button
          type="button"
          onClick={clearPins}
          className="text-xs opacity-50 hover:opacity-100"
          title="Unpin all"
        >
          Clear all
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ul>
          {pinnedFamilies.map((family) => (
            <li
              key={`fam:${family.familyName}`}
              className="px-6 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer flex flex-col gap-1.5"
              onClick={() => openFamily(family.familyName)}
            >
              <div
                className="flex items-center gap-2 text-xs min-w-0"
                style={{ opacity: 0.6 }}
              >
                <PinButton
                  pinned
                  onToggle={() => togglePin(family.familyName)}
                />
                <span className="truncate">{family.familyName}</span>
              </div>
              <div className="min-w-0">
                <FontPreview
                  repId={family.repId}
                  filePath={family.filePath}
                  ttcIndex={family.ttcIndex}
                  text={previewText || "The quick brown fox"}
                  size={previewSize}
                />
              </div>
            </li>
          ))}
          {pinnedGoogleFamilies.map((family) => (
            <li
              key={`gf:${family}`}
              className="px-6 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer flex flex-col gap-1.5"
              onClick={() => openGoogleFamily(family)}
            >
              <div
                className="flex items-center gap-2 text-xs min-w-0"
                style={{ opacity: 0.6 }}
              >
                <PinButton
                  pinned
                  onToggle={() => togglePinGoogleFamily(family)}
                />
                <GoogleFontHead family={family} />
                <span>·</span>
                <span className="uppercase tracking-wider">Google</span>
              </div>
              <div
                style={{
                  fontFamily: `'${family}', sans-serif`,
                  fontSize: previewSize,
                  lineHeight: 1.4,
                  paddingBottom: "0.12em",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {previewText || "The quick brown fox"}
              </div>
            </li>
          ))}
          {pinnedGoogleVariants.map(({ family, variant }) => {
            const label =
              variant === "regular"
                ? "Regular"
                : variant === "italic"
                  ? "Italic"
                  : variant;
            const m = variant.match(/^(\d+)(italic)?$/);
            const weight = m ? parseInt(m[1], 10) : 400;
            const italic = m ? !!m[2] : variant === "italic";
            return (
              <li
                key={`gv:${family}:${variant}`}
                className="px-6 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer flex flex-col gap-1.5"
                onClick={() => openGoogleFamily(family)}
              >
                <div
                  className="flex items-center gap-2 text-xs min-w-0"
                  style={{ opacity: 0.6 }}
                >
                  <PinButton
                    pinned
                    onToggle={() => togglePinGoogleVariant(family, variant)}
                  />
                  <GoogleFontHead family={family} />
                  <span>·</span>
                  <span>{label}</span>
                  <span>·</span>
                  <span className="uppercase tracking-wider">Google</span>
                </div>
                <div
                  style={{
                    fontFamily: `'${family}', sans-serif`,
                    fontWeight: weight,
                    fontStyle: italic ? "italic" : "normal",
                    fontSize: previewSize,
                    lineHeight: 1.4,
                    paddingBottom: "0.12em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {previewText || "The quick brown fox"}
                </div>
              </li>
            );
          })}
          {pinnedStyles.map((style: FontRow) => {
            const styleLabel =
              style.subfamily ??
              `${style.weight}${style.italic ? " Italic" : ""}`;
            return (
              <li
                key={`style:${style.id}`}
                className="px-6 py-3 hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer flex flex-col gap-1.5"
                onClick={() => openFamily(style.familyName)}
              >
                <div
                  className="flex items-center gap-2 text-xs min-w-0"
                  style={{ opacity: 0.6 }}
                >
                  <PinButton
                    pinned
                    onToggle={() => togglePinStyle(style)}
                  />
                  <span className="truncate">
                    {style.familyName} · {styleLabel}
                  </span>
                </div>
                <div className="min-w-0">
                  <FontPreview
                    repId={style.id}
                    filePath={style.filePath}
                    ttcIndex={style.ttcIndex}
                    text={previewText || "The quick brown fox"}
                    size={previewSize}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
