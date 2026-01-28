import { Index, Show, createEffect, createMemo, createSignal } from "solid-js";
import { writeText } from "@tauri-apps/api/clipboard";
import { confirm } from "@tauri-apps/api/dialog";
import { dirname } from "@tauri-apps/api/path";
import { open as openPath } from "@tauri-apps/api/shell";
import { invoke } from "@tauri-apps/api/tauri";
import type { FileEntry } from "../stores/scan";
import { formatBytes } from "../utils/format";

type Props = {
  files: FileEntry[];
  scanKey: number;
  onStorageRefresh?: (reason: string, detail?: string, force?: boolean) => void;
};

export default function TopFiles(props: Props) {
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [hiddenPaths, setHiddenPaths] = createSignal<Set<string>>(new Set());
  const [actionStatus, setActionStatus] = createSignal<{
    message: string;
    tone: "success" | "warning" | "error";
  } | null>(null);

  const formatName = (value: string) =>
    value
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const titleCase = (value: string) =>
    value
      .split(" ")
      .map((word) =>
        word ? word[0].toUpperCase() + word.slice(1) : word
      )
      .join(" ");

  const appHintForPath = (path: string) => {
    if (path.includes("/Library/Developer/Xcode/DerivedData/")) {
      return "App: Xcode Derived Data";
    }
    if (path.includes("/.android/avd/")) {
      return "App: Android Emulator";
    }
    if (path.includes("/Library/Android/sdk/")) {
      return "App: Android SDK";
    }

    const containerMatch = path.match(/\/Library\/Containers\/([^/]+)\//);
    if (containerMatch) {
      return `Container: ${containerMatch[1]}`;
    }

    const groupMatch = path.match(/\/Library\/Group Containers\/([^/]+)\//);
    if (groupMatch) {
      return `Group container: ${groupMatch[1]}`;
    }

    const appBundleMatch = path.match(
      /\/(?:Applications|System\/Applications)\/([^/]+?)\.app\//
    );
    if (appBundleMatch) {
      return `App: ${appBundleMatch[1]}`;
    }

    const appSupportMatch = path.match(
      /\/Library\/Application Support\/([^/]+)(?:\/([^/]+))?\//
    );
    if (appSupportMatch) {
      const vendor = formatName(appSupportMatch[1]);
      const app = appSupportMatch[2] ? formatName(appSupportMatch[2]) : "";
      const label = app ? `${vendor} ${app}` : vendor;
      return `App data: ${titleCase(label)}`;
    }

    const cacheMatch = path.match(/\/Library\/Caches\/([^/]+)\//);
    if (cacheMatch) {
      return `Cache: ${titleCase(formatName(cacheMatch[1]))}`;
    }

    const hiddenMatch = path.match(/\/Users\/[^/]+\/\.([^/]+)\//);
    if (hiddenMatch) {
      return `Hidden folder: .${hiddenMatch[1]}`;
    }

    return null;
  };

  const visibleFiles = createMemo(() => {
    const hidden = hiddenPaths();
    return props.files.filter((file) => !hidden.has(file.path));
  });

  createEffect(() => {
    props.scanKey;
    setHiddenPaths(new Set<string>());
    setSelectedPath(null);
    setActionStatus(null);
  });

  createEffect(() => {
    const selected = selectedPath();
    if (!selected) {
      return;
    }
    if (!visibleFiles().some((file) => file.path === selected)) {
      setSelectedPath(null);
    }
  });

  const getFileName = (path: string) => {
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  };

  const hidePath = (path: string) => {
    setHiddenPaths((current) => {
      const next = new Set(current);
      next.add(path);
      return next;
    });
  };

  const setStatus = (
    message: string,
    tone: "success" | "warning" | "error" = "success"
  ) => {
    setActionStatus({ message, tone });
  };

  const handleSelect = (file: FileEntry) => {
    setSelectedPath((current) => (current === file.path ? null : file.path));
    setActionStatus(null);
  };

  const handleReveal = async (file: FileEntry) => {
    try {
      const folder = await dirname(file.path);
      await openPath(folder);
      setStatus("Opened containing folder.");
    } catch (err) {
      console.error(err);
      setStatus("Could not open folder.", "error");
    }
  };

  const handleOpen = async (file: FileEntry) => {
    try {
      await openPath(file.path);
      setStatus("Opened file.");
    } catch (err) {
      console.error(err);
      setStatus("Could not open file.", "error");
    }
  };

  const handleCopy = async (file: FileEntry) => {
    try {
      await writeText(file.path);
      setStatus("Copied path to clipboard.");
    } catch (err) {
      console.error(err);
      setStatus("Could not copy path.", "error");
    }
  };

  // Sensitive paths that require extra confirmation
  const SENSITIVE_PATTERNS = [
    /\/\.ssh\//,
    /\/\.gnupg\//,
    /\/\.gpg/,
    /\/\.aws\//,
    /\/\.kube\//,
    /\/\.docker\//,
    /\/\.npmrc$/,
    /\/\.zshrc$/,
    /\/\.bashrc$/,
    /\/\.bash_profile$/,
    /\/\.gitconfig$/,
    /\/\.netrc$/,
    /\/id_rsa/,
    /\/id_ed25519/,
    /\/\.env/,
  ];

  const isSensitivePath = (path: string): boolean =>
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(path));

  // Debounce deletion to prevent rapid-fire deletes
  let lastDeleteTime = 0;
  const DELETE_DEBOUNCE_MS = 1000;

  const handleDelete = async (file: FileEntry) => {
    const now = Date.now();
    if (now - lastDeleteTime < DELETE_DEBOUNCE_MS) {
      setStatus("Please wait before deleting another file.", "warning");
      return;
    }

    const name = getFileName(file.path);
    const sensitive = isSensitivePath(file.path);

    // First confirmation
    const firstConfirm = await confirm(
      sensitive
        ? `⚠️ "${name}" appears to be a security-sensitive file.\n\nPath: ${file.path}\n\nAre you sure you want to delete it?`
        : `Delete "${name}"? This cannot be undone.`,
      {
        title: sensitive ? "Delete sensitive file" : "Delete file",
        type: "warning",
      }
    );

    if (!firstConfirm) {
      return;
    }

    // Extra confirmation for sensitive files
    if (sensitive) {
      const secondConfirm = await confirm(
        `FINAL WARNING: Deleting "${name}" may break authentication, encryption, or other security features.\n\nThis action is IRREVERSIBLE.`,
        {
          title: "Confirm deletion of sensitive file",
          type: "warning",
        }
      );
      if (!secondConfirm) {
        return;
      }
    }

    lastDeleteTime = Date.now();

    try {
      await invoke("delete_file", { path: file.path });
      hidePath(file.path);
      setStatus(sensitive ? "Sensitive file deleted." : "File deleted.", "warning");
      props.onStorageRefresh?.("delete", undefined, true);
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      setStatus(`Delete failed: ${message}`, "error");
    }
  };

  return (
    <div class="card top-files">
      <div class="card__header">
        <div>
          <h2>Top Files</h2>
          <div class="hint">Select a file to take action.</div>
        </div>
        <span class="muted">{visibleFiles().length} shown</span>
      </div>
      <Show
        when={visibleFiles().length > 0}
        fallback={<div class="placeholder">No files yet. Start a scan.</div>}
      >
        <ol class="file-list">
          <Index each={visibleFiles()}>
            {(file) => (
              <li
                class="file-row"
                classList={{ "is-selected": selectedPath() === file().path }}
                tabIndex={0}
                aria-selected={selectedPath() === file().path}
                onClick={() => handleSelect(file())}
                onDblClick={() => void handleOpen(file())}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleSelect(file());
                  }
                }}
              >
                <div class="file-row__main">
                  <span class="file-size">{formatBytes(file().size)}</span>
                  <div class="file-row__text">
                    <span class="file-path" title={file().path}>
                      {file().path}
                    </span>
                    <Show when={appHintForPath(file().path)}>
                      {(hint) => <span class="file-app">{hint()}</span>}
                    </Show>
                  </div>
                </div>
                <Show when={selectedPath() === file().path}>
                  <div class="file-row__details">
                    <div class="file-row__path">{file().path}</div>
                    <div class="file-actions">
                      <button
                        class="action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleReveal(file());
                        }}
                      >
                        Reveal in Finder
                      </button>
                      <button
                        class="action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleOpen(file());
                        }}
                      >
                        Open
                      </button>
                      <button
                        class="action-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleCopy(file());
                        }}
                      >
                        Copy path
                      </button>
                      <button
                        class="action-button danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(file());
                        }}
                      >
                        Delete
                      </button>
                    </div>
                    <Show when={actionStatus()}>
                      {(status) => (
                        <div
                          class="action-status"
                          classList={{
                            "is-warning": status().tone === "warning",
                            "is-error": status().tone === "error",
                          }}
                        >
                          {status().message}
                        </div>
                      )}
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </Index>
        </ol>
      </Show>
    </div>
  );
}
