use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const EMIT_INTERVAL: Duration = Duration::from_millis(200);
pub const DEFAULT_TOP_N: usize = 50;

type HeapEntry = (u64, String);

#[derive(Clone, Serialize)]
pub struct FileEntry {
  pub path: String,
  pub size: u64,
}

#[derive(Clone, Serialize)]
pub struct ProgressPayload {
  #[serde(rename = "scanId")]
  pub scan_id: u64,
  #[serde(rename = "scannedFiles")]
  pub scanned_files: u64,
  #[serde(rename = "scannedBytes")]
  pub scanned_bytes: u64,
  #[serde(rename = "currentPath")]
  pub current_path: String,
  #[serde(rename = "topFiles")]
  pub top_files: Vec<FileEntry>,
}

pub fn scan_directory(
  app: AppHandle,
  root: PathBuf,
  cancel: Arc<AtomicBool>,
  top_n: usize,
  scan_id: u64,
) -> bool {
  let mut dirs: VecDeque<PathBuf> = VecDeque::new();
  let mut heap: BinaryHeap<Reverse<HeapEntry>> = BinaryHeap::new();
  let mut scanned_files = 0u64;
  let mut scanned_bytes = 0u64;
  let mut current_path = String::new();
  let mut last_emit = Instant::now() - EMIT_INTERVAL;
  let mut cancelled = false;

  if let Ok(metadata) = fs::metadata(&root) {
    if metadata.is_file() {
      let size = metadata.len();
      let path_string = root.to_string_lossy().to_string();
      scanned_files = 1;
      scanned_bytes = size;
      current_path = path_string.clone();
      push_top(&mut heap, (size, path_string), top_n);
      emit_progress(
        &app,
        scanned_files,
        scanned_bytes,
        &current_path,
        &heap,
        scan_id,
        "scan_progress",
      );
      emit_progress(
        &app,
        scanned_files,
        scanned_bytes,
        &current_path,
        &heap,
        scan_id,
        "scan_complete",
      );
      return false;
    }
  }

  dirs.push_back(root);

  while let Some(dir) = dirs.pop_front() {
    if cancel.load(Ordering::Relaxed) {
      cancelled = true;
      break;
    }

    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(_) => continue,
    };

    for entry in entries {
      if cancel.load(Ordering::Relaxed) {
        cancelled = true;
        break;
      }

      let entry = match entry {
        Ok(entry) => entry,
        Err(_) => continue,
      };

      let file_type = match entry.file_type() {
        Ok(file_type) => file_type,
        Err(_) => continue,
      };

      if file_type.is_symlink() {
        continue;
      }

      let path = entry.path();
      let path_string = path.to_string_lossy().to_string();
      current_path = path_string.clone();

      if file_type.is_dir() {
        dirs.push_back(path);
        continue;
      }

      if !file_type.is_file() {
        continue;
      }

      let metadata = match entry.metadata() {
        Ok(metadata) => metadata,
        Err(_) => continue,
      };

      let size = metadata.len();
      scanned_files += 1;
      scanned_bytes += size;
      push_top(&mut heap, (size, path_string), top_n);

      if last_emit.elapsed() >= EMIT_INTERVAL {
        emit_progress(
          &app,
          scanned_files,
          scanned_bytes,
          &current_path,
          &heap,
          scan_id,
          "scan_progress",
        );
        last_emit = Instant::now();
      }
    }
  }

  emit_progress(
    &app,
    scanned_files,
    scanned_bytes,
    &current_path,
    &heap,
    scan_id,
    "scan_complete",
  );

  cancelled
}

fn push_top(heap: &mut BinaryHeap<Reverse<HeapEntry>>, entry: HeapEntry, limit: usize) {
  heap.push(Reverse(entry));
  if heap.len() > limit {
    heap.pop();
  }
}

fn emit_progress(
  app: &AppHandle,
  scanned_files: u64,
  scanned_bytes: u64,
  current_path: &str,
  heap: &BinaryHeap<Reverse<HeapEntry>>,
  scan_id: u64,
  event_name: &str,
) {
  let mut top_files: Vec<FileEntry> = heap
    .iter()
    .map(|entry| {
      let (size, path) = &entry.0;
      FileEntry {
        path: path.clone(),
        size: *size,
      }
    })
    .collect();

  top_files.sort_by(|a, b| b.size.cmp(&a.size));

  let payload = ProgressPayload {
    scan_id,
    scanned_files,
    scanned_bytes,
    current_path: current_path.to_string(),
    top_files,
  };

  let _ = app.emit_to("main", event_name, payload);
}
