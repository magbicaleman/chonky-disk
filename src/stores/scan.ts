import { createStore } from "solid-js/store";

export type FileEntry = {
  path: string;
  size: number;
  logicalSize: number;
};

export type ScanProgress = {
  scanId: number;
  scannedFiles: number;
  scannedBytes: number;
  scannedLogicalBytes: number;
  currentPath: string;
  topFiles: FileEntry[];
};

export const [scanState, setScanState] = createStore({
  inProgress: false,
  scannedFiles: 0,
  scannedBytes: 0,
  currentPath: "",
  topFiles: [] as FileEntry[],
});
