import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { FamilyList } from "./components/FamilyList";
import { FamilyDetail } from "./components/FamilyDetail";
import { GoogleFamilyDetail } from "./components/GoogleFamilyDetail";
import { PinnedDock } from "./components/PinnedDock";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/Toast";
import {
  initGoogleDownloadProgressListener,
  initScanProgressListener,
  useStore,
} from "./store";
import type { ScanSummary } from "./types";

function App() {
  const refresh = useStore((s) => s.refresh);
  const setDragActive = useStore((s) => s.setDragActive);
  const showSettings = useStore((s) => s.showSettings);
  const activationBusy = useStore((s) => s.activationBusy);
  const googleFontsLoading = useStore((s) => s.googleFontsLoading);
  const scanning = useStore((s) => s.scanning);
  const busy = activationBusy || googleFontsLoading || scanning;

  useEffect(() => {
    initScanProgressListener();
    initGoogleDownloadProgressListener();
    refresh();
    // Swallow native WebView2 context menu so our custom menu wins.
    const suppress = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", suppress);

    // Tauri drag-drop: accept dropped folders as new library roots
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent(async (event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            setDragActive(true);
          } else if (p.type === "leave") {
            setDragActive(false);
          } else if (p.type === "drop") {
            setDragActive(false);
            const paths = (p as { paths: string[] }).paths;
            for (const path of paths) {
              try {
                await invoke<ScanSummary>("scan_folder", { path });
              } catch (err) {
                console.error("scan_folder failed", path, err);
              }
            }
            await useStore.getState().refresh();
          }
        });
      } catch (e) {
        console.error("drag-drop listener failed", e);
      }
    })();

    return () => {
      document.removeEventListener("contextmenu", suppress);
      unlisten?.();
    };
  }, [refresh, setDragActive]);

  return (
    <div
      className="h-full w-full flex flex-col bg-[var(--color-bg)]"
      data-busy={busy ? "true" : undefined}
    >
      <Toast />
      <TopBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-hidden flex flex-col py-3 pr-3 pl-1 gap-3">
          {showSettings ? (
            <SettingsView />
          ) : (
            <>
              <div className="flex-1 min-h-0 flex gap-3">
                <div className="flex-1 min-w-0">
                  <FamilyList />
                </div>
                <FamilyDetail />
                <GoogleFamilyDetail />
              </div>
              <PinnedDock />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
