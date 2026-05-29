import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/api/clipboard";
import { dirname } from "@tauri-apps/api/path";
import { open as openPath } from "@tauri-apps/api/shell";
import { invoke } from "@tauri-apps/api/tauri";
import { redactName, redactPath } from "../stores/privacy";
import { formatBytes } from "../utils/format";

type FolderEntryKind = "folder" | "file";

type FolderEntry = {
  path: string;
  name: string;
  kind: FolderEntryKind;
  size: number;
  logicalSize: number;
  fileCount: number;
  folderCount: number;
  unreadableCount: number;
  stale?: boolean;
};

type FolderChildrenResponse = {
  path: string;
  entries: FolderEntry[];
  totalBytes: number;
  totalLogicalBytes: number;
  fileCount: number;
  folderCount: number;
  unreadableCount: number;
  fromCache?: boolean;
  stale?: boolean;
};

type NodeState = {
  expanded: boolean;
  loading: boolean;
  error: string | null;
  entries: FolderEntry[];
  summary: FolderChildrenResponse | null;
  stale: boolean;
};

type Props = {
  rootPath: string;
  fsChange?: FsChangePayload | null;
};

export type FsChangePayload = {
  path: string;
  kind: "create" | "modify" | "remove";
  size?: number | null;
  logicalSize?: number | null;
};

const emptyNodeState = (): NodeState => ({
  expanded: false,
  loading: false,
  error: null,
  entries: [],
  summary: null,
  stale: false,
});

export default function FolderMap(props: Props) {
  const [nodes, setNodes] = createSignal<Record<string, NodeState>>({});
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [actionStatus, setActionStatus] = createSignal<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [openMenuPath, setOpenMenuPath] = createSignal<string | null>(null);

  let loadVersion = 0;
  let menuCloseTimeout: number | undefined;

  const rootPath = createMemo(() => props.rootPath.trim());
  const rootState = createMemo(() => nodes()[rootPath()]);

  const setStatus = (message: string, tone: "success" | "error" = "success") => {
    setActionStatus({ message, tone });
  };

  const clearMenuCloseTimeout = () => {
    if (menuCloseTimeout) {
      window.clearTimeout(menuCloseTimeout);
      menuCloseTimeout = undefined;
    }
  };

  const closeMenuSoon = () => {
    clearMenuCloseTimeout();
    menuCloseTimeout = window.setTimeout(() => {
      setOpenMenuPath(null);
      menuCloseTimeout = undefined;
    }, 250);
  };

  const normalizePath = (path: string) => path.replace(/\/+$/, "");

  const isSameOrInside = (path: string, parent: string) => {
    const cleanPath = normalizePath(path);
    const cleanParent = normalizePath(parent);
    return cleanPath === cleanParent || cleanPath.startsWith(`${cleanParent}/`);
  };

  const parentPath = (path: string) => {
    const cleanPath = normalizePath(path);
    const index = cleanPath.lastIndexOf("/");
    return index > 0 ? cleanPath.slice(0, index) : "/";
  };

  const relativePath = (path: string) => {
    const root = normalizePath(rootPath());
    const cleanPath = normalizePath(path);
    if (!root || cleanPath === root) {
      return ".";
    }
    return cleanPath.startsWith(`${root}/`)
      ? cleanPath.slice(root.length + 1)
      : cleanPath;
  };

  const sortEntries = (entries: FolderEntry[]) =>
    entries.slice().sort((a, b) => {
      const sizeSort = b.size - a.size;
      if (sizeSort !== 0) {
        return sizeSort;
      }
      return (
        a.kind.localeCompare(b.kind) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      );
    });

  const diskUsageHelp = (size: number, logicalSize?: number) => {
    if (Number.isFinite(logicalSize) && (logicalSize as number) > size) {
      return `Disk used is what macOS is actually storing and what affects free space: ${formatBytes(
        size
      )}. Logical capacity is the apparent reserved size: ${formatBytes(
        logicalSize as number
      )}. Sparse files can look large without currently using that much disk.`;
    }
    return `Disk used is what macOS is actually storing and what affects free space: ${formatBytes(
      size
    )}.`;
  };

  const patchNode = (path: string, patch: Partial<NodeState>) => {
    setNodes((current) => ({
      ...current,
      [path]: {
        ...emptyNodeState(),
        ...current[path],
        ...patch,
      },
    }));
  };

  const applyFolderResponse = (response: FolderChildrenResponse) => {
    setNodes((current) => {
      const next: Record<string, NodeState> = {
        ...current,
        [response.path]: {
          ...emptyNodeState(),
          ...current[response.path],
          expanded: true,
          loading: false,
          error: null,
          entries: response.entries,
          summary: response,
          stale: !!response.stale,
        },
      };

      for (const [nodePath, node] of Object.entries(next)) {
        if (!node.entries.some((entry) => entry.path === response.path)) {
          continue;
        }
        next[nodePath] = {
          ...node,
          entries: sortEntries(
            node.entries.map((entry) =>
              entry.path === response.path
                ? {
                    ...entry,
                    size: response.totalBytes,
                    logicalSize: response.totalLogicalBytes,
                    fileCount: response.fileCount,
                    folderCount: response.folderCount,
                    unreadableCount: response.unreadableCount,
                    stale: !!response.stale,
                  }
                : entry
            )
          ),
        };
      }

      return next;
    });
  };

  const loadChildren = async (
    path: string,
    version = loadVersion,
    forceRefresh = false
  ) => {
    if (!path) {
      return;
    }

    patchNode(path, {
      expanded: true,
      loading: true,
      error: null,
    });

    try {
      const response = await invoke<FolderChildrenResponse>("folder_children", {
        path,
        forceRefresh,
      });
      if (version !== loadVersion) {
        return;
      }
      applyFolderResponse(response);
    } catch (err) {
      if (version !== loadVersion) {
        return;
      }
      patchNode(path, {
        expanded: true,
        loading: false,
        error: String(err),
      });
    }
  };

  const refreshRoot = () => {
    const path = rootPath();
    if (!path) {
      return;
    }
    loadVersion += 1;
    const version = loadVersion;
    setSelectedPath(null);
    setActionStatus(null);
    const expandedDescendants = Object.entries(nodes())
      .filter(([nodePath, state]) => state.expanded && nodePath !== path)
      .map(([nodePath]) => nodePath);
    void loadChildren(path, version, true);
    for (const descendant of expandedDescendants) {
      void loadChildren(descendant, version, true);
    }
  };

  const clearCache = async () => {
    try {
      await invoke("clear_cache");
      setStatus("Cleared cached folder index.");
    } catch (err) {
      console.error(err);
      setStatus("Could not clear cache.", "error");
      return;
    }
    refreshRoot();
  };

  createEffect(() => {
    const path = rootPath();
    loadVersion += 1;
    setNodes({});
    setSelectedPath(null);
    setActionStatus(null);
    if (path) {
      void loadChildren(path, loadVersion);
    }
  });

  const toggleFolder = (entry: FolderEntry) => {
    const state = nodes()[entry.path];
    if (state?.expanded) {
      patchNode(entry.path, { expanded: false });
      return;
    }
    if (state?.summary) {
      patchNode(entry.path, { expanded: true });
      return;
    }
    void loadChildren(entry.path);
  };

  const refreshEntry = (entry: FolderEntry) => {
    if (entry.kind !== "folder") {
      return;
    }
    setOpenMenuPath(null);
    setActionStatus(null);
    void loadChildren(entry.path, loadVersion, true);
  };

  onMount(() => {
    let unlisten: (() => void) | undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (!target.closest(".folder-row__menu-wrap")) {
        setOpenMenuPath(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenuPath(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    void listen<FolderChildrenResponse>(
      "folder_children_updated",
      (event) => {
        const response = event.payload;
        const root = rootPath();
        if (!root || !isSameOrInside(response.path, root)) {
          return;
        }
        untrack(() => applyFolderResponse(response));
      }
    ).then((dispose) => {
      unlisten = dispose;
    });

    onCleanup(() => {
      clearMenuCloseTimeout();
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      unlisten?.();
    });
  });

  const applySizeDelta = (
    value: number,
    delta: number,
    floor = 0
  ) => Math.max(floor, value + delta);

  const applyFsChange = (change: FsChangePayload) => {
    const root = rootPath();
    if (!root || !isSameOrInside(change.path, root)) {
      return;
    }

    setNodes((current) => {
      const changedPath = normalizePath(change.path);
      const changedParent = parentPath(changedPath);
      let knownOldEntry: FolderEntry | undefined;

      for (const node of Object.values(current)) {
        const match = node.entries.find(
          (entry) => normalizePath(entry.path) === changedPath
        );
        if (match) {
          knownOldEntry = match;
          break;
        }
      }

      const hasNewSize = Number.isFinite(change.size) && (change.size as number) >= 0;
      const newSize = hasNewSize ? (change.size as number) : 0;
      const hasNewLogicalSize =
        Number.isFinite(change.logicalSize) && (change.logicalSize as number) >= 0;
      const newLogicalSize = hasNewLogicalSize
        ? (change.logicalSize as number)
        : newSize;
      const exactDelta =
        change.kind === "remove"
          ? knownOldEntry
            ? -knownOldEntry.size
            : null
          : change.kind === "create"
          ? newSize
          : knownOldEntry
          ? newSize - knownOldEntry.size
          : null;
      const fileDelta =
        change.kind === "create" ? 1 : change.kind === "remove" && knownOldEntry ? -1 : 0;
      const exactLogicalDelta =
        exactDelta === null
          ? null
          : change.kind === "remove"
          ? knownOldEntry
            ? -knownOldEntry.logicalSize
            : null
          : change.kind === "create"
          ? newLogicalSize
          : knownOldEntry
          ? newLogicalSize - knownOldEntry.logicalSize
          : null;
      const shouldMarkStale = exactDelta === null;

      let changed = false;
      const next: Record<string, NodeState> = {};

      for (const [nodePath, node] of Object.entries(current)) {
        let nextNode = node;
        const nodeContainsChange = isSameOrInside(changedPath, nodePath);
        const nodeIsDirectParent = normalizePath(nodePath) === changedParent;
        const shouldTouchNode = nodeContainsChange || nodeIsDirectParent;

        if (!shouldTouchNode) {
          next[nodePath] = node;
          continue;
        }

        let entriesChanged = false;
        let entries = node.entries;

        if (nodeIsDirectParent) {
          const existingIndex = entries.findIndex(
            (entry) => normalizePath(entry.path) === changedPath
          );
          if (change.kind === "remove" && existingIndex >= 0) {
            entries = [
              ...entries.slice(0, existingIndex),
              ...entries.slice(existingIndex + 1),
            ];
            entriesChanged = true;
          } else if (change.kind !== "remove" && hasNewSize) {
            if (existingIndex >= 0) {
              entries = entries.map((entry, index) =>
                index === existingIndex
                  ? {
                      ...entry,
                      size: newSize,
                      logicalSize: newLogicalSize,
                      stale: false,
                    }
                  : entry
              );
            } else {
              entries = [
                ...entries,
                {
                  path: changedPath,
                  name: changedPath.slice(changedPath.lastIndexOf("/") + 1),
                  kind: "file",
                  size: newSize,
                  logicalSize: newLogicalSize,
                  fileCount: 1,
                  folderCount: 0,
                  unreadableCount: 0,
                },
              ];
            }
            entries = sortEntries(entries);
            entriesChanged = true;
          }
        }

        if (exactDelta !== null || shouldMarkStale) {
          entries = entries.map((entry) => {
            if (
              entry.kind !== "folder" ||
              !isSameOrInside(changedPath, entry.path) ||
              normalizePath(entry.path) === changedPath
            ) {
              return entry;
            }
            entriesChanged = true;
            return {
              ...entry,
              size:
                exactDelta === null
                  ? entry.size
                  : applySizeDelta(entry.size, exactDelta),
              fileCount: applySizeDelta(entry.fileCount, fileDelta),
              logicalSize:
                exactLogicalDelta === null
                  ? entry.logicalSize
                  : applySizeDelta(entry.logicalSize, exactLogicalDelta),
              stale: exactDelta === null || entry.stale,
            };
          });
          if (exactDelta !== null && entriesChanged) {
            entries = sortEntries(entries);
          }
        }

        if (entriesChanged) {
          nextNode = { ...nextNode, entries };
        }

        if (nodeContainsChange && node.summary) {
          nextNode = {
            ...nextNode,
            summary:
              exactDelta === null
                ? node.summary
                : {
                    ...node.summary,
                    totalBytes: applySizeDelta(node.summary.totalBytes, exactDelta),
                    totalLogicalBytes:
                      exactLogicalDelta === null
                        ? node.summary.totalLogicalBytes
                        : applySizeDelta(
                            node.summary.totalLogicalBytes,
                            exactLogicalDelta
                          ),
                    fileCount: applySizeDelta(node.summary.fileCount, fileDelta),
                  },
            stale: shouldMarkStale || node.stale,
          };
        }

        changed = changed || nextNode !== node;
        next[nodePath] = nextNode;
      }

      return changed ? next : current;
    });
  };

  createEffect(() => {
    const change = props.fsChange;
    if (!change) {
      return;
    }
    untrack(() => applyFsChange(change));
  });

  const handleReveal = async (entry: FolderEntry) => {
    try {
      const folder = await dirname(entry.path);
      await openPath(folder);
      setStatus("Opened containing folder.");
    } catch (err) {
      console.error(err);
      setStatus("Could not open folder.", "error");
    }
  };

  const handleOpen = async (entry: FolderEntry) => {
    try {
      await openPath(entry.path);
      setStatus("Opened item.");
    } catch (err) {
      console.error(err);
      setStatus("Could not open item.", "error");
    }
  };

  const handleCopy = async (entry: FolderEntry) => {
    try {
      await writeText(entry.path);
      setStatus("Copied path to clipboard.");
    } catch (err) {
      console.error(err);
      setStatus("Could not copy path.", "error");
    }
  };

  const handleCopyRelative = async (entry: FolderEntry) => {
    try {
      await writeText(relativePath(entry.path));
      setOpenMenuPath(null);
      setStatus("Copied relative path to clipboard.");
    } catch (err) {
      console.error(err);
      setStatus("Could not copy path.", "error");
    }
  };

  const metaText = (entry: FolderEntry) => {
    if (entry.kind === "file") {
      if (entry.logicalSize > entry.size) {
        return `File / logical capacity ${formatBytes(entry.logicalSize)}`;
      }
      return "File";
    }

    const parts = [
      `${entry.fileCount.toLocaleString()} files`,
      `${entry.folderCount.toLocaleString()} folders`,
    ];
    if (entry.logicalSize > entry.size) {
      parts.push(`logical capacity ${formatBytes(entry.logicalSize)}`);
    }
    if (entry.stale) {
      parts.push("needs refresh");
    }
    if (entry.unreadableCount > 0) {
      parts.push(`${entry.unreadableCount.toLocaleString()} skipped`);
    }
    return parts.join(" / ");
  };

  function FolderNodes(nodeProps: {
    entries: FolderEntry[];
    depth: number;
    parentSize: number;
  }) {
    return (
      <ul class="folder-tree__group">
        <For each={nodeProps.entries}>
          {(entry, index) => (
            <FolderNode
              entry={entry}
              index={index()}
              depth={nodeProps.depth}
              parentSize={nodeProps.parentSize}
            />
          )}
        </For>
      </ul>
    );
  }

  function FolderNode(nodeProps: {
    entry: FolderEntry;
    index: number;
    depth: number;
    parentSize: number;
  }) {
    const entry = nodeProps.entry;
    const isFolder = () => entry.kind === "folder";
    const state = () => nodes()[entry.path];
    const percent = () => {
      if (nodeProps.parentSize <= 0 || entry.size <= 0) {
        return 0;
      }
      return Math.max(2, Math.min(100, (entry.size / nodeProps.parentSize) * 100));
    };

    return (
      <li
        class="folder-node"
        classList={{ "is-menu-open": openMenuPath() === entry.path }}
      >
        <div
          class="folder-row"
          classList={{
            "is-selected": selectedPath() === entry.path,
            "is-file": !isFolder(),
            "is-stale": !!entry.stale,
            "is-menu-open": openMenuPath() === entry.path,
          }}
          style={`--depth: ${nodeProps.depth};`}
          tabIndex={0}
          aria-selected={selectedPath() === entry.path}
          onClick={() => {
            setSelectedPath((current) =>
              current === entry.path ? null : entry.path
            );
            setActionStatus(null);
            setOpenMenuPath(null);
          }}
          onDblClick={() => (isFolder() ? toggleFolder(entry) : void handleOpen(entry))}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (isFolder()) {
                toggleFolder(entry);
              } else {
                setSelectedPath(entry.path);
              }
            }
          }}
        >
          <div class="folder-row__topline">
            <button
              class="folder-row__toggle"
              classList={{
                "is-expanded": !!state()?.expanded,
                "is-loading": !!state()?.loading,
              }}
              disabled={!isFolder()}
              aria-label={state()?.expanded ? "Collapse folder" : "Expand folder"}
              title={state()?.expanded ? "Collapse" : "Expand"}
              onClick={(event) => {
                event.stopPropagation();
                if (isFolder()) {
                  toggleFolder(entry);
                }
              }}
            />
            <span
              class="folder-row__icon"
              classList={{ "is-file": !isFolder() }}
              aria-hidden="true"
            />
            <div class="folder-row__identity">
              <div class="folder-row__name" title={redactPath(entry.path)}>
                {redactName(entry.name, nodeProps.index, entry.kind)}
              </div>
              <div class="folder-row__meta">{metaText(entry)}</div>
            </div>
            <div class="folder-row__size">
              <span class="folder-row__size-label">
                Disk used
                <button
                  class="metric-info"
                  type="button"
                  aria-label="What disk used means"
                  data-tooltip={diskUsageHelp(entry.size, entry.logicalSize)}
                  onClick={(event) => event.stopPropagation()}
                >
                  i
                </button>
              </span>
              {formatBytes(entry.size)}
            </div>
            <div class="folder-row__menu-wrap">
              <button
                class="folder-row__menu-button"
                aria-label="Folder actions"
                aria-haspopup="menu"
                aria-expanded={openMenuPath() === entry.path}
                title="Actions"
                onClick={(event) => {
                  event.stopPropagation();
                  clearMenuCloseTimeout();
                  setOpenMenuPath((current) =>
                    current === entry.path ? null : entry.path
                  );
                }}
              >
                ...
              </button>
              <Show when={openMenuPath() === entry.path}>
                <div
                  class="folder-row__menu"
                  role="menu"
                  onPointerEnter={clearMenuCloseTimeout}
                  onPointerLeave={closeMenuSoon}
                >
                  <Show when={isFolder()}>
                    <button
                      role="menuitem"
                      onClick={(event) => {
                        event.stopPropagation();
                        refreshEntry(entry);
                      }}
                    >
                      Refresh
                    </button>
                  </Show>
                  <button
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      void handleReveal(entry);
                    }}
                  >
                    Open in Finder
                  </button>
                  <button
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuPath(null);
                      void handleCopy(entry);
                    }}
                  >
                    Copy full path
                  </button>
                  <button
                    role="menuitem"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleCopyRelative(entry);
                    }}
                  >
                    Copy relative path
                  </button>
                </div>
              </Show>
            </div>
          </div>
          <div class="folder-row__bar" aria-hidden="true">
            <div class="folder-row__bar-fill" style={{ width: `${percent()}%` }} />
          </div>
          <Show when={selectedPath() === entry.path}>
            <div class="folder-row__details">
              <div class="file-row__path">{redactPath(entry.path)}</div>
              <div class="file-row__path file-row__path--metric">
                Disk used: {formatBytes(entry.size)}
              </div>
              <Show when={entry.logicalSize > entry.size}>
                <div class="file-row__path file-row__path--metric">
                  Logical capacity: {formatBytes(entry.logicalSize)}
                </div>
              </Show>
              <div class="file-actions">
                <button
                  class="action-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleReveal(entry);
                  }}
                >
                  Reveal in Finder
                </button>
                <button
                  class="action-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleOpen(entry);
                  }}
                >
                  Open
                </button>
                <button
                  class="action-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCopy(entry);
                  }}
                >
                  Copy path
                </button>
              </div>
              <Show when={actionStatus()}>
                {(status) => (
                  <div
                    class="action-status"
                    classList={{ "is-error": status().tone === "error" }}
                  >
                    {status().message}
                  </div>
                )}
              </Show>
            </div>
          </Show>
        </div>
        <Show when={isFolder() && state()?.expanded}>
          <Show when={(state()?.entries.length ?? 0) > 0}>
            <div
              classList={{ "is-refreshing": !!state()?.loading }}
              aria-busy={!!state()?.loading}
            >
              <FolderNodes
                entries={state()?.entries ?? []}
                depth={nodeProps.depth + 1}
                parentSize={entry.size}
              />
            </div>
          </Show>
          <Show when={(state()?.entries.length ?? 0) === 0}>
            <Show when={state()?.loading}>
              <div
                class="folder-tree__loading"
                style={`--depth: ${nodeProps.depth + 1};`}
              >
                Measuring folder...
              </div>
            </Show>
            <Show when={state()?.error}>
              {(error) => (
                <div
                  class="folder-tree__error"
                  style={`--depth: ${nodeProps.depth + 1};`}
                >
                  {error()}
                </div>
              )}
            </Show>
            <Show when={!state()?.loading && !state()?.error}>
              <div
                class="folder-tree__empty"
                style={`--depth: ${nodeProps.depth + 1};`}
              >
                Empty folder
              </div>
            </Show>
          </Show>
        </Show>
      </li>
    );
  }

  return (
    <div class="card folder-map">
      <div class="card__header">
        <div class="hint" title={redactPath(rootPath())}>
          <Show when={rootState()?.stale} fallback={"Sorted by disk used"}>
            Needs refresh — values may be stale
          </Show>
        </div>
        <div class="folder-map__actions">
          <button
            class="button ghost"
            onClick={clearCache}
            disabled={!rootPath() || !!rootState()?.loading}
            title="Delete the on-disk cached folder index and re-measure"
          >
            Clear cache
          </button>
          <button
            class="button ghost folder-map__refresh"
            classList={{ "is-loading": !!rootState()?.loading }}
            onClick={refreshRoot}
            disabled={!rootPath() || !!rootState()?.loading}
          >
            Refresh
          </button>
        </div>
      </div>

      <Show
        when={rootPath()}
        fallback={<div class="placeholder">Choose a folder to scan.</div>}
      >
        <Show when={rootState()?.summary}>
          {(summary) => (
            <div class="folder-map__summary">
              <div>
                <div class="stat__label">
                  Disk used
                  <button
                    class="metric-info"
                    type="button"
                    aria-label="What disk used means"
                    data-tooltip={diskUsageHelp(
                      summary().totalBytes,
                      summary().totalLogicalBytes
                    )}
                  >
                    i
                  </button>
                </div>
                <div class="folder-map__summary-value">
                  {formatBytes(summary().totalBytes)}
                </div>
                <Show when={summary().totalLogicalBytes > summary().totalBytes}>
                  <div class="folder-map__summary-note">
                    Logical capacity: {formatBytes(summary().totalLogicalBytes)}
                  </div>
                </Show>
              </div>
              <div>
                <div class="stat__label">Contents</div>
                <div class="folder-map__summary-value">
                  {summary().fileCount.toLocaleString()} files /{" "}
                  {summary().folderCount.toLocaleString()} folders
                </div>
              </div>
            </div>
          )}
        </Show>

        <Show when={(rootState()?.entries.length ?? 0) > 0}>
          <div
            class="folder-tree"
            classList={{ "is-refreshing": !!rootState()?.loading }}
            aria-busy={!!rootState()?.loading}
          >
            <FolderNodes
              entries={rootState()?.entries ?? []}
              depth={0}
              parentSize={rootState()?.summary?.totalBytes ?? 0}
            />
          </div>
          <Show when={rootState()?.error}>
            {(error) => (
              <div class="placeholder is-error" style={{ "margin-top": "10px" }}>
                {error()}
              </div>
            )}
          </Show>
        </Show>
        <Show when={(rootState()?.entries.length ?? 0) === 0}>
          <Show when={rootState()?.loading}>
            <div class="placeholder">Measuring folder...</div>
          </Show>
          <Show when={rootState()?.error}>
            {(error) => <div class="placeholder is-error">{error()}</div>}
          </Show>
          <Show when={!rootState()?.loading && !rootState()?.error}>
            <div class="placeholder">No folders or files found.</div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
