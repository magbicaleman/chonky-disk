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
import TopFiles from "./components/TopFiles";
import { scanState, setScanState, type ScanProgress } from "./stores/scan";
import { formatBytes, formatDuration } from "./utils/format";

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
};

type LogEntry = {
  id: number;
  timestamp: number;
  message: string;
};

const HISTORY_STORAGE_KEY = "chonky.scanHistory.v1";
const TOP_FILES_LIMIT = 50;
const DISK_REFRESH_THROTTLE_MS = 8000;

export default function App() {
  const [folder, setFolder] = createSignal("");
  const [homePath, setHomePath] = createSignal("");
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
            next[existingIndex] = { path, size: size as number };
          } else {
            const smallest = next[next.length - 1]?.size ?? 0;
            if (next.length >= TOP_FILES_LIMIT && (size as number) <= smallest) {
              return files;
            }
            next.push({ path, size: size as number });
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
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(scanHistory())
    );
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

  const volumeSubtitle = createMemo(() => {
    const mount = diskInfo()?.mountPoint;
    if (!mount) {
      return "";
    }
    if (mount === "/System/Volumes/Data") {
      return "Data volume • /System/Volumes/Data";
    }
    if (mount === "/") {
      return "System volume • /";
    }
    return `Mounted at ${mount}`;
  });

  return (
    <div class="app">
      <header class="hero">
        <div>
          <div class="eyebrow">Chonky Disk</div>
          <h1>Find the biggest files fast.</h1>
          <p class="subtitle">
            Scan a folder and watch the heaviest files rise to the top in real
            time.
          </p>
        </div>
        <div class="status">
          <div
            class="status-pill"
            classList={{ "is-live": scanState.inProgress }}
          >
            {scanState.inProgress ? "Live Scan" : "Idle"}
          </div>
          <div class="status-meta">{statusText()}</div>
        </div>
      </header>

      <section class="card storage">
        <div class="storage__header">
          <div>
            <div class="label">Storage</div>
            <div class="storage__title">
              {volumeDisplayName() || "Select a folder to see disk usage"}
            </div>
            <Show when={volumeSubtitle()}>
              <div class="storage__subtitle">{volumeSubtitle()}</div>
            </Show>
            <div
              class="storage__meta storage__meta--status"
              classList={{ "is-visible": diskLoading() }}
            >
              Updating disk usage...
            </div>
            <Show when={diskError()}>
              <div class="storage__meta is-error">{diskError()}</div>
            </Show>
          </div>
          <div class="storage__stats">
            <button
              class="button ghost storage__refresh"
              classList={{ "is-loading": diskLoading() }}
              onClick={() => requestDiskRefresh("manual", undefined, true)}
              disabled={!diskPath() || diskLoading()}
            >
              Refresh
            </button>
            <div class="storage__stat">
              <div class="stat__label">Used</div>
              <div class="storage__value">
                {diskInfo() ? formatBytes(diskInfo()!.usedBytes) : "—"}
              </div>
            </div>
            <div class="storage__stat">
              <div class="stat__label">Free</div>
              <div class="storage__value">
                {diskInfo() ? formatBytes(diskInfo()!.availableBytes) : "—"}
              </div>
            </div>
            <div class="storage__stat">
              <div class="stat__label">Total</div>
              <div class="storage__value">
                {diskInfo() ? formatBytes(diskInfo()!.totalBytes) : "—"}
              </div>
            </div>
          </div>
        </div>
        <div class="storage__bar" classList={{ "is-loading": diskLoading() }}>
          <div
            class="storage__used"
            style={{ width: `${usedPercent()}%` }}
          />
        </div>
        <div class="storage__legend">
          {diskInfo()
            ? `${formatBytes(diskInfo()!.usedBytes)} used of ${formatBytes(
                diskInfo()!.totalBytes
              )} • ${formatBytes(diskInfo()!.availableBytes)} free`
            : "Awaiting folder selection"}
        </div>
      </section>

      <section class="card controls">
        <div class="label">Scan Folder</div>
        <div class="controls-row">
          <input
            class="input"
            value={folder()}
            onInput={(event) => setFolder(event.currentTarget.value)}
            placeholder="Choose a folder"
          />
          <button class="button ghost" onClick={chooseFolder}>
            Browse
          </button>
        </div>
        <div class="controls-row">
          <button
            class="button primary"
            onClick={startScan}
            disabled={!folder() || scanState.inProgress}
          >
            Start Scan
          </button>
          <button
            class="button"
            onClick={cancelScan}
            disabled={!scanState.inProgress}
          >
            Cancel
          </button>
          <Show when={error()}>
            <span class="error">{error()}</span>
          </Show>
        </div>
      </section>

      <section class="grid">
        <div class="stack">
          <div class="card stats">
            <div class="progress">
              <div
                class="progress__bar"
                classList={{
                  "is-active": scanState.inProgress,
                  "is-complete": !scanState.inProgress,
                }}
              />
            </div>
            <div class="stat-grid">
              <div>
                <div class="stat__label">Files scanned</div>
                <div class="stat__value">
                  {scanState.scannedFiles.toLocaleString()}
                </div>
              </div>
              <div>
                <div class="stat__label">Bytes scanned</div>
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
                    : "Not yet"}
                </div>
              </div>
            </div>
            <div class="current-path">
              <div class="stat__label">Current path</div>
              <div class="path">
                {scanState.currentPath || "Waiting for a scan..."}
              </div>
            </div>
          </div>
          <div class="card history">
            <div class="card__header">
              <h2>Scan History</h2>
              <span class="muted">{scanHistory().length} runs</span>
            </div>
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
                          {formatDuration(entry.durationMs)} •{" "}
                          {entry.scannedFiles.toLocaleString()} files •{" "}
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
        </div>
        <TopFiles
          files={scanState.topFiles}
          scanKey={scanKey()}
          onStorageRefresh={requestDiskRefresh}
        />
      </section>

      <section class="card activity">
        <div class="card__header">
          <h2>Activity Log</h2>
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
      </section>
    </div>
  );
}
