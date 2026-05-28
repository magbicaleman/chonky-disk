import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { writeText } from "@tauri-apps/api/clipboard";
import { dirname } from "@tauri-apps/api/path";
import { open as openPath } from "@tauri-apps/api/shell";
import { invoke } from "@tauri-apps/api/tauri";
import { formatBytes } from "../utils/format";

type FolderEntryKind = "folder" | "file";

type FolderEntry = {
  path: string;
  name: string;
  kind: FolderEntryKind;
  size: number;
  fileCount: number;
  folderCount: number;
  unreadableCount: number;
};

type FolderChildrenResponse = {
  path: string;
  entries: FolderEntry[];
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  unreadableCount: number;
};

type NodeState = {
  expanded: boolean;
  loading: boolean;
  error: string | null;
  entries: FolderEntry[];
  summary: FolderChildrenResponse | null;
};

type Props = {
  rootPath: string;
};

const emptyNodeState = (): NodeState => ({
  expanded: false,
  loading: false,
  error: null,
  entries: [],
  summary: null,
});

export default function FolderMap(props: Props) {
  const [nodes, setNodes] = createSignal<Record<string, NodeState>>({});
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [actionStatus, setActionStatus] = createSignal<{
    message: string;
    tone: "success" | "error";
  } | null>(null);

  let loadVersion = 0;

  const rootPath = createMemo(() => props.rootPath.trim());
  const rootState = createMemo(() => nodes()[rootPath()]);

  const displayRootName = createMemo(() => {
    const path = rootPath();
    if (!path) {
      return "No folder selected";
    }
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || path;
  });

  const setStatus = (message: string, tone: "success" | "error" = "success") => {
    setActionStatus({ message, tone });
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

  const loadChildren = async (path: string, version = loadVersion) => {
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
      });
      if (version !== loadVersion) {
        return;
      }
      patchNode(path, {
        expanded: true,
        loading: false,
        error: null,
        entries: response.entries,
        summary: response,
      });
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
    setNodes({});
    setSelectedPath(null);
    setActionStatus(null);
    void loadChildren(path, loadVersion);
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

  const metaText = (entry: FolderEntry) => {
    if (entry.kind === "file") {
      return "File";
    }

    const parts = [
      `${entry.fileCount.toLocaleString()} files`,
      `${entry.folderCount.toLocaleString()} folders`,
    ];
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
          {(entry) => (
            <FolderNode
              entry={entry}
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
      <li class="folder-node">
        <div
          class="folder-row"
          classList={{
            "is-selected": selectedPath() === entry.path,
            "is-file": !isFolder(),
          }}
          style={`--depth: ${nodeProps.depth};`}
          tabIndex={0}
          aria-selected={selectedPath() === entry.path}
          onClick={() => {
            setSelectedPath((current) =>
              current === entry.path ? null : entry.path
            );
            setActionStatus(null);
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
              <div class="folder-row__name" title={entry.path}>
                {entry.name}
              </div>
              <div class="folder-row__meta">{metaText(entry)}</div>
            </div>
            <div class="folder-row__size">{formatBytes(entry.size)}</div>
          </div>
          <div class="folder-row__bar" aria-hidden="true">
            <div class="folder-row__bar-fill" style={{ width: `${percent()}%` }} />
          </div>
          <Show when={selectedPath() === entry.path}>
            <div class="folder-row__details">
              <div class="file-row__path">{entry.path}</div>
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
            <Show
              when={(state()?.entries.length ?? 0) > 0}
              fallback={
                <div
                  class="folder-tree__empty"
                  style={`--depth: ${nodeProps.depth + 1};`}
                >
                  Empty folder
                </div>
              }
            >
              <FolderNodes
                entries={state()?.entries ?? []}
                depth={nodeProps.depth + 1}
                parentSize={entry.size}
              />
            </Show>
          </Show>
        </Show>
      </li>
    );
  }

  return (
    <div class="card folder-map">
      <div class="card__header">
        <div>
          <h2>Folder Tree</h2>
          <div class="hint" title={rootPath()}>
            {displayRootName()}
          </div>
        </div>
        <button
          class="button ghost folder-map__refresh"
          classList={{ "is-loading": !!rootState()?.loading }}
          onClick={refreshRoot}
          disabled={!rootPath() || !!rootState()?.loading}
        >
          Refresh
        </button>
      </div>

      <Show
        when={rootPath()}
        fallback={<div class="placeholder">Choose a folder to scan.</div>}
      >
        <Show when={rootState()?.summary}>
          {(summary) => (
            <div class="folder-map__summary">
              <div>
                <div class="stat__label">Measured</div>
                <div class="folder-map__summary-value">
                  {formatBytes(summary().totalBytes)}
                </div>
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

        <Show when={rootState()?.loading}>
          <div class="placeholder">Measuring folder...</div>
        </Show>
        <Show when={rootState()?.error}>
          {(error) => <div class="placeholder is-error">{error()}</div>}
        </Show>
        <Show when={!rootState()?.loading && !rootState()?.error}>
          <Show
            when={(rootState()?.entries.length ?? 0) > 0}
            fallback={<div class="placeholder">No folders or files found.</div>}
          >
            <div class="folder-tree">
              <FolderNodes
                entries={rootState()?.entries ?? []}
                depth={0}
                parentSize={rootState()?.summary?.totalBytes ?? 0}
              />
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
