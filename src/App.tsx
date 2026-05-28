import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { homeDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/tauri";
import FolderMap from "./components/FolderMap";
import TopFiles from "./components/TopFiles";
import { scanState, setScanState, type ScanProgress } from "./stores/scan";
import { formatBytes, formatDuration, formatStorageBytes } from "./utils/format";

type ScanHistoryEntry = {
  id: number;
  rootPath: string;
  scannedFiles: number;
  scannedBytes: number;
  durationMs: number;
  finishedAt: number;
};

type DiskOverview = {
  rootPath: string;
  mountPoint: string;
  volumeName: string;
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
};

type FsChangePayload = {
  scanId: number;
  path: string;
  kind: "create" | "modify" | "remove";
  size?: number | null;
  logicalSize?: number | null;
};

type LogEntry = {
  id: number;
  timestamp: number;
  message: string;
};

type AppMode = "explore" | "cleanup";
type Theme = "light" | "dark";

const HISTORY_STORAGE_KEY = "chonky.scanHistory.v1";
const THEME_STORAGE_KEY = "chonky.theme.v1";
const TOP_FILES_LIMIT = 50;
const DISK_REFRESH_THROTTLE_MS = 8000;
const STORAGE_FREE_HELP =
  "Free now is raw APFS space available immediately. macOS Settings may show a higher Available number because it can include purgeable or reclaimable space.";
const STORAGE_USED_HELP =
  "Used is total capacity minus raw APFS free space. macOS Settings can show slightly less used space when it counts purgeable data as available.";

export default function App() {
  const [folder, setFolder] = createSignal("");
  const [homePath, setHomePath] = createSignal("");
  const [mode, setMode] = createSignal<AppMode>("explore");
  const [theme, setTheme] = createSignal<Theme>("light");
  const [scanId, setScanId] = createSignal<number | null>(null);
  const [ignoredScanId, setIgnoredScanId] = createSignal<number | null>(null);
  const [completedScanId, setCompletedScanId] = createSignal<number | null>(
    null
  );
  const [scanKey, setScanKey] = createSignal(0);
  const [scanStartedAt, setScanStartedAt] = createSignal<number | null>(null);
  const [scanElapsedMs, setScanElapsedMs] = createSignal(0);
  const [lastDurationMs, setLastDurationMs] = createSignal<number | null>(null);
  const [scanHistory, setScanHistory] = createSignal<ScanHistoryEntry[]>([]);
  const [historyLoaded, setHistoryLoaded] = createSignal(false);
  const [scanRootPath, setScanRootPath] = createSignal("");
  const [diskInfo, setDiskInfo] = createSignal<DiskOverview | null>(null);
  const [diskError, setDiskError] = createSignal<string | null>(null);
  const [diskLoading, setDiskLoading] = createSignal(false);
  const [activityLog, setActivityLog] = createSignal<LogEntry[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [folderFsChange, setFolderFsChange] =
    createSignal<FsChangePayload | null>(null);

  let unlistenProgress: (() => void) | undefined;
  let unlistenComplete: (() => void) | undefined;
  let unlistenFsChange: (() => void) | undefined;
  let diskRequestId = 0;
  let diskRefreshTimeout: number | undefined;
  let logId = 0;
  let lastDiskRefreshAt = 0;

  const shouldHandleEvent = (
    payload: ScanProgress,
    eventType: "progress" | "complete"
  ) => {
    const completedId = completedScanId();
    if (completedId !== null && payload.scanId === completedId) {
      return false;
    }
    const ignoredId = ignoredScanId();
    if (ignoredId !== null && payload.scanId === ignoredId) {
      return false;
    }
    if (eventType === "progress" && !scanState.inProgress) {
      return false;
    }
    const activeId = scanId();
    if (activeId === null) {
      setScanId(payload.scanId);
      setIgnoredScanId(null);
      return true;
    }
    return payload.scanId === activeId;
  };

  onMount(async () => {
    // Theme: stored preference, else system.
    let initialTheme: Theme = "light";
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        initialTheme = stored;
      } else if (
        typeof matchMedia !== "undefined" &&
        matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        initialTheme = "dark";
      }
    }
    setTheme(initialTheme);

    try {
      const home = await homeDir();
      setHomePath(home);
      if (!folder()) {
        setFolder(home);
      }
    } catch {
      setHomePath("");
    }

    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            const cleaned = parsed.filter((entry) => {
              if (!entry || typeof entry !== "object") {
                return false;
              }
              const record = entry as ScanHistoryEntry;
              return (
                Number.isFinite(record.id) &&
                typeof record.rootPath === "string" &&
                Number.isFinite(record.scannedFiles) &&
                Number.isFinite(record.scannedBytes) &&
                Number.isFinite(record.durationMs) &&
                Number.isFinite(record.finishedAt)
              );
            });
            setScanHistory(cleaned.slice(0, 6));
          }
        } catch {
          // Ignore malformed stored data.
        }
      }
    }
    setHistoryLoaded(true);

    unlistenProgress = await listen<ScanProgress>(
      "scan_progress",
      (event) => {
        if (!shouldHandleEvent(event.payload, "progress")) {
          return;
        }
        setScanState({
          scannedFiles: event.payload.scannedFiles,
          scannedBytes: event.payload.scannedBytes,
          currentPath: event.payload.currentPath,
          topFiles: event.payload.topFiles,
        });
      }
    );

    unlistenComplete = await listen<ScanProgress>(
      "scan_complete",
      (event) => {
        if (!shouldHandleEvent(event.payload, "complete")) {
          return;
        }
        const finishedAt = Date.now();
        const startedAt = scanStartedAt();
        const durationMs = startedAt ? finishedAt - startedAt : 0;

        if (durationMs > 0) {
          setLastDurationMs(durationMs);
          setScanElapsedMs(durationMs);
        }

        setScanHistory((history) => {
          if (history[0]?.id === event.payload.scanId) {
            return history;
          }
          const entry: ScanHistoryEntry = {
            id: event.payload.scanId,
            rootPath: scanRootPath() || folder(),
            scannedFiles: event.payload.scannedFiles,
            scannedBytes: event.payload.scannedBytes,
            durationMs,
            finishedAt,
          };
          return [entry, ...history].slice(0, 6);
        });

        setScanState({
          inProgress: false,
          scannedFiles: event.payload.scannedFiles,
          scannedBytes: event.payload.scannedBytes,
          currentPath: event.payload.currentPath,
          topFiles: event.payload.topFiles,
        });
        setCompletedScanId(event.payload.scanId);
        setScanStartedAt(null);
      }
    );

    unlistenFsChange = await listen<FsChangePayload>(
      "scan_fs_change",
      (event) => {
        const activeId = scanId();
        if (!activeId || event.payload.scanId !== activeId) {
          return;
        }
        if (scanState.inProgress) {
          return;
        }

        setFolderFsChange({ ...event.payload });

        setScanState("topFiles", (files) => {
          let next = files.slice();
          const { path, kind, size } = event.payload;

          if (kind === "remove") {
            const prefix = path.endsWith("/") ? path : `${path}/`;
            const filtered = next.filter(
              (file) => file.path !== path && !file.path.startsWith(prefix)
            );
            return filtered.length === next.length ? files : filtered;
          }

          if (!Number.isFinite(size) || (size as number) <= 0) {
            return files;
          }

          const existingIndex = next.findIndex((file) => file.path === path);
          if (existingIndex >= 0) {
            next[existingIndex] = {
              path,
              size: size as number,
              logicalSize:
                event.payload.logicalSize ?? next[existingIndex].logicalSize,
            };
          } else {
            const smallest = next[next.length - 1]?.size ?? 0;
            if (next.length >= TOP_FILES_LIMIT && (size as number) <= smallest) {
              return files;
            }
            next.push({
              path,
              size: size as number,
              logicalSize: event.payload.logicalSize ?? (size as number),
            });
          }

          next.sort((a, b) => b.size - a.size);
          if (next.length > TOP_FILES_LIMIT) {
            next = next.slice(0, TOP_FILES_LIMIT);
          }
          return next;
        });

        const shouldRefresh =
          event.payload.kind === "create" || event.payload.kind === "remove";
        if (shouldRefresh && diskPath()) {
          if (diskRefreshTimeout) {
            clearTimeout(diskRefreshTimeout);
          }
          diskRefreshTimeout = window.setTimeout(() => {
            requestDiskRefresh(
              `fs ${event.payload.kind}`,
              shortPath(event.payload.path)
            );
          }, 900);
        }
      }
    );
  });

  onCleanup(() => {
    unlistenProgress?.();
    unlistenComplete?.();
    unlistenFsChange?.();
    if (diskRefreshTimeout) {
      clearTimeout(diskRefreshTimeout);
    }
  });

  createEffect(() => {
    const next = theme();
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", next === "dark");
    }
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    }
  });

  const toggleTheme = () =>
    setTheme((current) => (current === "dark" ? "light" : "dark"));

  const chooseFolder = async () => {
    setError(null);
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: folder() || homePath() || undefined,
    });

    if (typeof selected === "string") {
      setFolder(selected);
    }
  };

  const startScan = async () => {
    if (!folder()) {
      setError("Choose a folder to scan.");
      return;
    }

    setError(null);
    const previousScanId = scanId();
    setIgnoredScanId(previousScanId);
    setScanId(null);
    setScanState({
      inProgress: true,
      scannedFiles: 0,
      scannedBytes: 0,
      currentPath: "",
      topFiles: [],
    });
    setScanKey((value) => value + 1);
    setScanStartedAt(Date.now());
    setScanElapsedMs(0);
    setLastDurationMs(null);
    setScanRootPath(folder());
    setCompletedScanId(null);

    try {
      const id = await invoke<number>("start_scan", {
        rootPath: folder(),
      });
      setScanId(id);
      setIgnoredScanId(null);
    } catch (err) {
      setScanState("inProgress", false);
      setScanStartedAt(null);
      setScanElapsedMs(0);
      setScanId(previousScanId ?? null);
      setIgnoredScanId(null);
      setError(String(err));
    }
  };

  const cancelScan = async () => {
    const id = scanId();
    if (!id) {
      return;
    }

    try {
      await invoke<boolean>("cancel_scan", { scanId: id });
    } finally {
      setScanState("inProgress", false);
      setCompletedScanId(id);
    }
  };

  createEffect(() => {
    if (!scanState.inProgress) {
      return;
    }
    const startedAt = scanStartedAt();
    if (!startedAt) {
      return;
    }
    setScanElapsedMs(Date.now() - startedAt);
    const interval = setInterval(() => {
      setScanElapsedMs(Date.now() - startedAt);
    }, 500);
    return () => clearInterval(interval);
  });

  const shortPath = (value: string) => {
    if (value.length <= 64) {
      return value;
    }
    return `...${value.slice(-60)}`;
  };

  const addLog = (message: string) => {
    const entry: LogEntry = {
      id: (logId += 1),
      timestamp: Date.now(),
      message,
    };
    setActivityLog((entries) => [entry, ...entries].slice(0, 80));
  };

  const fetchDiskOverview = async (path: string) => {
    const requestId = ++diskRequestId;
    setDiskLoading(true);
    setDiskError(null);

    try {
      const overview = await invoke<DiskOverview>("disk_overview", {
        rootPath: path,
      });
      if (requestId !== diskRequestId) {
        return;
      }
      setDiskInfo(overview);
    } catch (err) {
      if (requestId !== diskRequestId) {
        return;
      }
      setDiskInfo(null);
      setDiskError(String(err));
    } finally {
      if (requestId === diskRequestId) {
        setDiskLoading(false);
      }
    }
  };

  const diskPath = createMemo(() => folder() || homePath());

  const requestDiskRefresh = (
    reason: string,
    detail?: string,
    force = false
  ) => {
    const path = diskPath();
    if (!path) {
      return;
    }
    if (!force && diskLoading()) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastDiskRefreshAt < DISK_REFRESH_THROTTLE_MS) {
      return;
    }
    lastDiskRefreshAt = now;
    const suffix = detail ? ` (${detail})` : "";
    addLog(`Storage refresh: ${reason}${suffix}`);
    void fetchDiskOverview(path);
  };

  createEffect(() => {
    const path = diskPath();
    if (!path) {
      setDiskInfo(null);
      return;
    }
    const timeout = window.setTimeout(() => {
      void fetchDiskOverview(path);
    }, 250);
    onCleanup(() => clearTimeout(timeout));
  });

  createEffect(() => {
    if (!historyLoaded() || typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(scanHistory()));
  });

  const statusText = createMemo(() => {
    if (scanState.inProgress) {
      return "Streaming file sizes...";
    }
    const lastDuration = lastDurationMs();
    if (lastDuration) {
      return `Last scan: ${formatDuration(lastDuration)}.`;
    }
    return "Ready when you are.";
  });

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

  const usedPercent = createMemo(() => {
    const percent = diskInfo()?.usedPercent;
    if (!Number.isFinite(percent)) {
      return 0;
    }
    return Math.max(0, Math.min(100, percent!));
  });

  const volumeDisplayName = createMemo(() => {
    const info = diskInfo();
    if (!info) {
      return "";
    }
    const name = info.volumeName || info.mountPoint || info.rootPath;
    if (info.mountPoint === "/System/Volumes/Data" && name.endsWith(" - Data")) {
      return name.replace(/ - Data$/, "");
    }
    return name;
  });

  const crumbs = createMemo(() => {
    const path = folder();
    if (!path) {
      return [] as string[];
    }
    return path.split("/").filter(Boolean);
  });

  const folderName = createMemo(() => {
    const parts = crumbs();
    return parts[parts.length - 1] || "/";
  });

  const locations = createMemo(() => {
    const home = homePath();
    if (!home) {
      return [] as { label: string; path: string }[];
    }
    return [
      { label: "Home", path: home },
      { label: "Documents", path: `${home}/Documents` },
      { label: "Downloads", path: `${home}/Downloads` },
      { label: "Desktop", path: `${home}/Desktop` },
    ];
  });

  const goTo = (path: string) => {
    if (!path) {
      return;
    }
    setError(null);
    setFolder(path);
  };

  const capacityNote = createMemo(() => {
    const info = diskInfo();
    if (!info) {
      return "Reading volume...";
    }
    return `${formatStorageBytes(info.usedBytes)} / ${formatStorageBytes(
      info.totalBytes
    )} · ${formatStorageBytes(info.availableBytes)} free`;
  });

  return (
    <div class="window">
      <div class="toolbar">
        <div class="nav">
          <button class="iconbtn" disabled title="Back">
            ‹
          </button>
          <button class="iconbtn" disabled title="Forward">
            ›
          </button>
        </div>
        <div class="breadcrumb">
          <Show
            when={crumbs().length > 0}
            fallback={<span class="crumb">No folder selected</span>}
          >
            <For each={crumbs()}>
              {(part, index) => (
                <>
                  <Show when={index() > 0}>
                    <span class="sep">›</span>
                  </Show>
                  <Show
                    when={index() === crumbs().length - 1}
                    fallback={<span class="crumb">{part}</span>}
                  >
                    <b class="crumb">{part}</b>
                  </Show>
                </>
              )}
            </For>
          </Show>
        </div>
        <div class="spacer" />
        <Show when={mode() === "explore"}>
          <div class="segmented" role="tablist" aria-label="Folder view">
            <button class="active" role="tab" aria-selected="true">
              List
            </button>
            <button role="tab" aria-selected="false" disabled title="Coming soon">
              Map
            </button>
          </div>
        </Show>
        <button
          class="toggle"
          title="Toggle light / dark"
          aria-label="Toggle light or dark theme"
          onClick={toggleTheme}
        >
          ◐
        </button>
        <button class="btn" onClick={chooseFolder}>
          Browse
        </button>
        <Show when={mode() === "cleanup"}>
          <Show
            when={!scanState.inProgress}
            fallback={
              <button class="btn danger" onClick={cancelScan}>
                Cancel
              </button>
            }
          >
            <button
              class="btn primary"
              onClick={startScan}
              disabled={!folder()}
            >
              Scan
            </button>
          </Show>
        </Show>
      </div>

      <div class="body">
        <aside class="sidebar">
          <div class="side-label">View</div>
          <button
            class="side-item"
            classList={{ active: mode() === "explore" }}
            onClick={() => setMode("explore")}
          >
            <span class="dot">⊞</span>
            <span class="side-item__body">
              <span class="label-main">Explore</span>
              <span class="side-sub">Folder breakdown</span>
            </span>
          </button>
          <button
            class="side-item"
            classList={{ active: mode() === "cleanup" }}
            onClick={() => setMode("cleanup")}
          >
            <span class="dot">⌦</span>
            <span class="side-item__body">
              <span class="label-main">Clean up</span>
              <span class="side-sub">Largest files</span>
            </span>
          </button>

          <div class="side-label">Locations</div>
          <For each={locations()}>
            {(loc) => (
              <button
                class="side-item"
                classList={{ active: folder() === loc.path }}
                onClick={() => goTo(loc.path)}
              >
                <span class="dot">›</span>
                <span class="side-item__body">
                  <span class="label-main">{loc.label}</span>
                </span>
              </button>
            )}
          </For>

          <div class="side-label">Volume</div>
          <div class="capsule">
            <div class="capbar">
              <i style={{ width: `${usedPercent()}%` }} />
            </div>
            <div class="capnote" title={volumeDisplayName()}>
              {capacityNote()}
            </div>
            <Show when={diskError()}>
              <div class="capnote" style={{ color: "var(--error)" }}>
                {diskError()}
              </div>
            </Show>
          </div>

          <div class="sidebar__spacer" />
        </aside>

        <section class="content">
          <div class="content__head">
            <div>
              <h1>
                {mode() === "explore" ? folderName() : "Largest files"}
              </h1>
              <div class="sub">
                {mode() === "explore"
                  ? folder() || "Choose a folder to explore"
                  : scanState.scannedFiles > 0
                  ? `${scanState.scannedFiles.toLocaleString()} files · ${formatBytes(
                      scanState.scannedBytes
                    )} scanned in ${folder()}`
                  : `Scan ${folder() || "a folder"} to find space hogs`}
              </div>
            </div>
            <div
              class="status-pill"
              classList={{ "is-live": scanState.inProgress }}
              title={statusText()}
            >
              {scanState.inProgress ? "Scanning" : "Idle"}
            </div>
          </div>

          <Show when={error()}>
            <div class="error">{error()}</div>
          </Show>

          <Show when={mode() === "explore"}>
            <FolderMap rootPath={folder()} fsChange={folderFsChange()} />
          </Show>

          <Show when={mode() === "cleanup"}>
            <div class="scanbar">
              <div class="progress">
                <div
                  class="progress__bar"
                  classList={{
                    "is-active": scanState.inProgress,
                    "is-complete": !scanState.inProgress,
                  }}
                />
              </div>
              <div class="scanbar__stats">
                <div>
                  <div class="stat__label">Files scanned</div>
                  <div class="stat__value">
                    {scanState.scannedFiles.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div class="stat__label">Disk used scanned</div>
                  <div class="stat__value">
                    {formatBytes(scanState.scannedBytes)}
                  </div>
                </div>
                <div>
                  <div class="stat__label">Scan time</div>
                  <div class="stat__value">
                    {scanState.inProgress
                      ? formatDuration(scanElapsedMs())
                      : lastDurationMs()
                      ? formatDuration(lastDurationMs()!)
                      : "—"}
                  </div>
                </div>
              </div>
              <div class="scanbar__path">
                <b>{scanState.currentPath || "Idle — press Scan to begin."}</b>
              </div>
            </div>

            <TopFiles
              files={scanState.topFiles}
              scanKey={scanKey()}
              onStorageRefresh={requestDiskRefresh}
            />
          </Show>

          <details class="drawer">
            <summary>Activity &amp; history</summary>
            <div class="drawer__body">
              <div class="drawer__section">
                <h3>Recent scans</h3>
                <Show
                  when={scanHistory().length > 0}
                  fallback={
                    <div class="placeholder">No scans yet. Run one above.</div>
                  }
                >
                  <ol class="history-list">
                    <For each={scanHistory()}>
                      {(entry) => (
                        <li class="history-row">
                          <div>
                            <div class="history-path" title={entry.rootPath}>
                              {entry.rootPath}
                            </div>
                            <div class="history-meta">
                              {formatDuration(entry.durationMs)} ·{" "}
                              {entry.scannedFiles.toLocaleString()} files ·{" "}
                              {formatBytes(entry.scannedBytes)}
                            </div>
                          </div>
                          <div class="history-time">
                            {formatTime(entry.finishedAt)}
                          </div>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </div>

              <div class="drawer__section">
                <div class="card__header" style={{ "margin-bottom": "8px" }}>
                  <h3 style={{ margin: "0" }}>Activity log</h3>
                  <button
                    class="button ghost activity__clear"
                    onClick={() => setActivityLog([])}
                    disabled={activityLog().length === 0}
                  >
                    Clear
                  </button>
                </div>
                <Show
                  when={activityLog().length > 0}
                  fallback={<div class="placeholder">No activity yet.</div>}
                >
                  <ol class="activity-list">
                    <For each={activityLog()}>
                      {(entry) => (
                        <li class="activity-row">
                          <span class="activity-time">
                            {formatTime(entry.timestamp)}
                          </span>
                          <span class="activity-message">{entry.message}</span>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </div>
            </div>
          </details>
        </section>
      </div>

      <div class="statusbar">
        <span class="seg">
          {scanState.scannedFiles > 0
            ? `${scanState.scannedFiles.toLocaleString()} items scanned`
            : statusText()}
        </span>
        <Show when={diskInfo()}>
          {(info) => (
            <>
              <span class="dotdiv" />
              <span class="seg" data-tooltip={STORAGE_USED_HELP}>
                {formatStorageBytes(info().usedBytes)} used
              </span>
              <span class="dotdiv" />
              <span class="seg" data-tooltip={STORAGE_FREE_HELP}>
                {formatStorageBytes(info().availableBytes)} free
              </span>
            </>
          )}
        </Show>
        <div class="spacer" />
        <span class="seg">
          {diskLoading() ? "Updating disk usage…" : volumeDisplayName()}
        </span>
      </div>
    </div>
  );
}
