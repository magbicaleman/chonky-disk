import { createSignal } from "solid-js";

// Privacy Mode is a display-only feature: it changes how values are rendered
// so the window can be screenshotted without leaking the macOS username,
// absolute paths, or personal folder/file names. It never touches scanning,
// the Rust commands, the data model, clipboard output, or logging — only the
// text that reaches the screen. All redaction lives in this one file so it is
// easy to audit and stays consistent across components.

const PRIVACY_STORAGE_KEY = "chonky.privacyMode.v1";

const readStored = (): boolean => {
  if (typeof localStorage === "undefined") {
    return false;
  }
  return localStorage.getItem(PRIVACY_STORAGE_KEY) === "1";
};

// Reactive: any JSX that calls a redact* helper re-renders when this flips,
// so toggling updates the view instantly with no rescan. Defaults OFF and is
// persisted to localStorage so it survives app restarts.
const [privacyMode, setPrivacyModeSignal] = createSignal<boolean>(readStored());

export { privacyMode };

export const setPrivacyMode = (value: boolean) => {
  setPrivacyModeSignal(value);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(PRIVACY_STORAGE_KEY, value ? "1" : "0");
  }
};

export const togglePrivacyMode = () => setPrivacyMode(!privacyMode());

// The user's home directory, used to collapse absolute paths down to "~".
const [homeDir, setHomeDirSignal] = createSignal<string>("");

export const setPrivacyHome = (home: string) => {
  setHomeDirSignal(home.replace(/\/+$/, ""));
};

// Collapse the home directory / macOS username out of an absolute path, e.g.
// /Users/jane/dev -> ~/dev. This is true text replacement (not CSS blur) so it
// cannot be recovered from a screenshot. Returns the input unchanged when
// Privacy Mode is off.
export const redactPath = (path: string): string => {
  if (!privacyMode() || !path) {
    return path;
  }
  const home = homeDir();
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  // Catch any other /Users/<name> prefix (e.g. a different account) so the
  // username never appears even if it isn't the current home directory.
  return path.replace(/^\/Users\/[^/]+/, "~");
};

// Replace a folder/file name with a neutral, stable placeholder while leaving
// sizes and counts untouched. `index` keeps placeholders distinct within a
// list ("Folder 1", "Folder 2", ...).
export const redactName = (
  name: string,
  index?: number,
  kind: "folder" | "file" = "folder"
): string => {
  if (!privacyMode()) {
    return name;
  }
  const label = kind === "file" ? "File" : "Folder";
  return typeof index === "number" ? `${label} ${index + 1}` : label;
};

// Redact a full file path for display: keep the (home-collapsed) directory for
// context but replace the personal file name with a placeholder.
export const redactFilePath = (path: string, index?: number): string => {
  if (!privacyMode() || !path) {
    return path;
  }
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const placeholder = typeof index === "number" ? `File ${index + 1}` : "File";
  return dir ? `${redactPath(dir)}/${placeholder}` : placeholder;
};

// Redact the full path of an entry inside a scanned tree. The scan root is
// shown home-collapsed (it is already visible in the breadcrumb), every
// folder name between the root and the entry is elided, and the entry's own
// name becomes the same placeholder the list row shows, e.g.
// /Users/jane/Documents/Taxes/2025 -> ~/Documents/…/Folder 2.
export const redactEntryPath = (
  path: string,
  root: string,
  index?: number,
  kind: "folder" | "file" = "folder"
): string => {
  if (!privacyMode() || !path) {
    return path;
  }
  const cleanPath = path.replace(/\/+$/, "");
  const cleanRoot = root.replace(/\/+$/, "");
  const placeholder = redactName("", index, kind);
  if (cleanRoot && cleanPath.startsWith(`${cleanRoot}/`)) {
    const depth = cleanPath.slice(cleanRoot.length + 1).split("/").length;
    const middle = depth > 1 ? "/…" : "";
    return `${redactPath(cleanRoot)}${middle}/${placeholder}`;
  }
  // Outside the scan root: keep nothing but the home-collapsed prefix.
  const home = redactPath(cleanPath).startsWith("~") ? "~" : "";
  return home ? `${home}/…/${placeholder}` : `…/${placeholder}`;
};

// Redact the volume / mount label shown in the status bar and sidebar.
export const redactVolume = (name: string): string => {
  if (!privacyMode() || !name) {
    return name;
  }
  return "This volume";
};
