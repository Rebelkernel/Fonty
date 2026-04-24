import { useEffect } from "react";
import { useStore } from "../store";

function formatBytes(n: number): string {
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${(n / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/**
 * Full-bleed settings card that replaces the main rendering area when
 * the user clicks the gear in the sidebar. Uses the app surface colours
 * (not the user-picked preview colours) so controls always stay readable.
 */
export function SettingsView() {
  const setShowSettings = useStore((s) => s.setShowSettings);
  const deactivateAllFonts = useStore((s) => s.deactivateAllFonts);
  const clearUserFontsRegistry = useStore((s) => s.clearUserFontsRegistry);
  const uninstallUserInstalledFonts = useStore(
    (s) => s.uninstallUserInstalledFonts,
  );
  const clearGoogleCache = useStore((s) => s.clearGoogleCache);
  const clearInactiveGoogleCache = useStore((s) => s.clearInactiveGoogleCache);
  const loadGoogleCacheSize = useStore((s) => s.loadGoogleCacheSize);
  const googleCacheBytes = useStore((s) => s.googleCacheBytes);
  const activationBusy = useStore((s) => s.activationBusy);
  const resetPreviewColors = useStore((s) => s.resetPreviewColors);
  const clearPins = useStore((s) => s.clearPins);
  const restoreOnLaunch = useStore((s) => s.restoreOnLaunch);
  const setRestoreOnLaunch = useStore((s) => s.setRestoreOnLaunch);
  const errorLog = useStore((s) => s.errorLog);
  const clearErrorLog = useStore((s) => s.clearErrorLog);
  const showToast = useStore((s) => s.showToast);

  // Refresh the cache size every time the Settings card opens so the label
  // next to the clear buttons stays accurate without polling.
  useEffect(() => {
    loadGoogleCacheSize();
  }, [loadGoogleCacheSize]);

  return (
    <div className="flex-1 min-h-0 flex">
      <div
        className="flex-1 min-w-0 flex flex-col rounded-3xl overflow-hidden"
        style={{
          backgroundColor: "var(--color-settings-surface)",
          color: "var(--color-text)",
        }}
      >
        <header
          className="px-6 py-4 flex items-center gap-3 shrink-0"
          style={{ borderBottom: "1px solid rgba(128,128,128,0.15)" }}
        >
          <div className="flex-1 min-w-0">
            <div
              className="text-[10px] uppercase tracking-wider"
              style={{ opacity: 0.5 }}
            >
              FONTY
            </div>
            <div className="text-lg font-medium">Settings</div>
          </div>
          <button
            type="button"
            onClick={() => setShowSettings(false)}
            className="text-xl leading-none w-8 h-8 rounded hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center"
            title="Close settings"
            aria-label="Close settings"
          >
            ×
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
          <SettingsGroup
            title="Startup"
            description="Control what happens when FONTY starts."
          >
            <ToggleRow
              label="Restore active fonts on launch"
              description="When on, every font that was active when you quit will be re-loaded into Windows the next time FONTY opens. When off, launches start clean."
              checked={restoreOnLaunch}
              onChange={setRestoreOnLaunch}
            />
          </SettingsGroup>

          <SettingsGroup
            title="Maintenance"
            description="Clean up Windows font registrations. System fonts are never touched."
          >
            <ActionButton
              onClick={deactivateAllFonts}
              disabled={activationBusy}
              label="Deactivate all Fonty fonts"
              description="Removes per-user font registrations FONTY added this session."
            />
            <ActionButton
              onClick={async () => {
                const n = await clearUserFontsRegistry();
                if (n > 0)
                  console.info(`Cleared ${n} per-user font registrations`);
              }}
              disabled={activationBusy}
              label="Clean all user-installed fonts"
              description="Wipes every HKCU per-user font entry — FONTY, FontBase leftovers, and any other app's installs. Files on disk are left alone. Windows system fonts stay put."
              danger
            />
            <ActionButton
              onClick={uninstallUserInstalledFonts}
              disabled={activationBusy}
              label="Uninstall all user fonts from system"
              description="Full uninstall — deletes HKCU registry entries AND the files in %LOCALAPPDATA%\Microsoft\Windows\Fonts. System fonts in C:\Windows\Fonts are not touched."
              danger
            />
            <ActionButton
              onClick={clearInactiveGoogleCache}
              label={`Clear cache for inactive Google families${
                googleCacheBytes > 0 ? ` (${formatBytes(googleCacheBytes)} total)` : ""
              }`}
              description="Sweep every downloaded Google family that isn't currently active. Active families stay untouched. A good one-click house-cleaning after a long session."
            />
            <ActionButton
              onClick={clearGoogleCache}
              label={`Clear Google Fonts cache${
                googleCacheBytes > 0 ? ` (${formatBytes(googleCacheBytes)})` : ""
              }`}
              description="Delete every downloaded Google TTF from disk, including active ones. Keeps re-activation fast — only run this when you need the disk space."
              danger
            />
          </SettingsGroup>

          <SettingsGroup
            title="Preview"
            description="Controls that affect how fonts are shown in the library."
          >
            <ActionButton
              onClick={resetPreviewColors}
              label="Reset preview colours"
              description="Restore the default dark preview text/background."
            />
            <ActionButton
              onClick={clearPins}
              label="Clear pinned fonts"
              description="Empties the comparison dock at the bottom of the main view."
            />
          </SettingsGroup>

          <SettingsGroup
            title="Error log"
            description="Anything that goes wrong while talking to Google Fonts lands here. Copy it and send the text to Claude to trace specific failures."
          >
            <ErrorLogPanel
              entries={errorLog}
              onCopy={() => {
                const payload = formatErrorLog(errorLog);
                void navigator.clipboard.writeText(payload).then(
                  () =>
                    showToast(
                      errorLog.length > 0
                        ? `Copied ${errorLog.length} entries to clipboard`
                        : "Log is empty",
                    ),
                  () => showToast("Copy failed — clipboard permission denied"),
                );
              }}
              onClear={() => {
                clearErrorLog();
                showToast("Error log cleared");
              }}
            />
          </SettingsGroup>

          <SettingsGroup
            title="About"
            description="FONTY — your local Windows font manager."
          >
            <div className="text-xs" style={{ opacity: 0.5 }}>
              Activations live under HKCU and never touch{" "}
              <code className="text-[11px]">C:\Windows\Fonts</code>. Close the
              window to keep fonts loaded in the tray; use{" "}
              <strong>Quit FONTY</strong> from the tray menu to deactivate
              everything on exit.
            </div>
          </SettingsGroup>
        </div>
      </div>
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <div
          className="text-[10px] uppercase tracking-[0.08em] font-medium"
          style={{ color: "var(--color-text-faint)" }}
        >
          {title}
        </div>
        {description && (
          <div className="text-xs mt-0.5" style={{ opacity: 0.55 }}>
            {description}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className="flex items-start gap-3 text-left px-3 py-2 rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-black/5 dark:hover:bg-white/5"
      style={{ borderColor: "rgba(128,128,128,0.2)" }}
    >
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs mt-0.5" style={{ opacity: 0.55 }}>
            {description}
          </div>
        )}
      </div>
      <div
        className="shrink-0 mt-0.5 relative inline-flex items-center w-9 h-5 rounded-full transition-colors"
        style={{
          backgroundColor: checked
            ? "var(--color-accent)"
            : "rgba(128,128,128,0.35)",
        }}
        aria-checked={checked}
        role="switch"
      >
        <span
          className="absolute w-4 h-4 rounded-full bg-white transition-transform shadow"
          style={{
            transform: checked ? "translateX(18px)" : "translateX(2px)",
          }}
        />
      </div>
    </button>
  );
}

function ActionButton({
  onClick,
  label,
  description,
  disabled,
  danger,
}: {
  onClick: () => void | Promise<unknown>;
  label: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="text-left px-3 py-2 rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:bg-black/5 dark:hover:bg-white/5"
      style={{
        borderColor: "rgba(128,128,128,0.2)",
      }}
    >
      <div
        className="text-sm font-medium"
        style={{
          color: danger ? "var(--color-danger)" : "var(--color-text)",
        }}
      >
        {label}
      </div>
      {description && (
        <div className="text-xs mt-0.5" style={{ opacity: 0.55 }}>
          {description}
        </div>
      )}
    </button>
  );
}

type ErrorEntry = { time: number; context: string; message: string };

function ErrorLogPanel({
  entries,
  onCopy,
  onClear,
}: {
  entries: ErrorEntry[];
  onCopy: () => void;
  onClear: () => void;
}) {
  const empty = entries.length === 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCopy}
          disabled={empty}
          className="px-3 py-1.5 rounded-md border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-black/5 dark:hover:bg-white/5"
          style={{ borderColor: "rgba(128,128,128,0.3)" }}
          title="Copy the full log to clipboard so you can paste it in chat"
        >
          Copy log{empty ? "" : ` (${entries.length})`}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={empty}
          className="px-3 py-1.5 rounded-md border text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-black/5 dark:hover:bg-white/5"
          style={{
            borderColor: "rgba(128,128,128,0.3)",
            color: empty ? undefined : "var(--color-danger)",
          }}
        >
          Clear
        </button>
      </div>
      <div
        className="rounded-md border px-3 py-2 text-[11px] font-mono leading-snug overflow-auto"
        style={{
          borderColor: "rgba(128,128,128,0.2)",
          maxHeight: 220,
          backgroundColor: "rgba(0,0,0,0.04)",
        }}
      >
        {empty ? (
          <span style={{ opacity: 0.5 }}>No errors logged yet.</span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {[...entries]
              .reverse()
              .slice(0, 50)
              .map((e, i) => (
                <div key={`${e.time}-${i}`} className="break-words">
                  <span style={{ opacity: 0.5 }}>
                    {new Date(e.time).toLocaleTimeString()}{" "}
                  </span>
                  <span style={{ color: "var(--color-accent)" }}>
                    [{e.context}]
                  </span>{" "}
                  <span>{e.message}</span>
                </div>
              ))}
            {entries.length > 50 && (
              <div style={{ opacity: 0.5 }}>
                … {entries.length - 50} older entries hidden (Copy includes
                all of them)
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatErrorLog(entries: ErrorEntry[]): string {
  if (entries.length === 0) return "(error log empty)";
  const header = `FONTY error log — ${entries.length} entries, exported ${new Date().toISOString()}\n`;
  const body = entries
    .map(
      (e) =>
        `[${new Date(e.time).toISOString()}] ${e.context}\n  ${e.message}`,
    )
    .join("\n\n");
  return `${header}\n${body}\n`;
}
