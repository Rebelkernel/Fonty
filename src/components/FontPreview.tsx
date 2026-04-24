import { useEffect, useMemo } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

const faceRefCount = new Map<string, number>();

function fontFaceFor(id: number) {
  return `fonty-${id}`;
}

function registerFace(fontFamily: string, url: string) {
  const count = faceRefCount.get(fontFamily) ?? 0;
  if (count === 0) {
    const style = document.createElement("style");
    style.setAttribute("data-fonty-face", fontFamily);
    style.textContent = `@font-face {
      font-family: '${fontFamily}';
      src: url('${url}');
      font-display: block;
    }`;
    document.head.appendChild(style);
  }
  faceRefCount.set(fontFamily, count + 1);
}

function unregisterFace(fontFamily: string) {
  const count = faceRefCount.get(fontFamily) ?? 0;
  if (count <= 1) {
    faceRefCount.delete(fontFamily);
    const el = document.querySelector(
      `style[data-fonty-face="${CSS.escape(fontFamily)}"]`,
    );
    if (el) el.remove();
  } else {
    faceRefCount.set(fontFamily, count - 1);
  }
}

export function FontPreview({
  repId,
  filePath,
  ttcIndex,
  text,
  size,
}: {
  repId: number;
  filePath: string;
  ttcIndex: number;
  text: string;
  size: number;
}) {
  const fontFamily = fontFaceFor(repId);
  const url = useMemo(() => convertFileSrc(filePath), [filePath]);
  const canPreview = ttcIndex === 0;

  useEffect(() => {
    if (!canPreview) return;
    registerFace(fontFamily, url);
    return () => unregisterFace(fontFamily);
  }, [fontFamily, url, canPreview]);

  const baseStyle: React.CSSProperties = {
    fontSize: size,
    // Roomier line-height + a touch of padding so descenders (g, p, q, y)
    // aren't clipped in our overflow-hidden containers.
    lineHeight: 1.4,
    paddingBottom: "0.12em",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  if (!canPreview) {
    return (
      <div
        style={baseStyle}
        className="text-[var(--color-text-faint)] italic"
        title="Preview of TTC/OTC collections is coming in a later milestone"
      >
        {text}
      </div>
    );
  }

  return (
    <div style={{ ...baseStyle, fontFamily: `'${fontFamily}', sans-serif` }}>
      {text}
    </div>
  );
}
