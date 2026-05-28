mod cache;
mod scanner;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use scanner::DEFAULT_TOP_N;
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::ffi::CStr;
#[cfg(target_family = "unix")]
use std::ffi::CString;
#[cfg(target_family = "unix")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_family = "unix")]
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::path::PathBuf;
use std::ptr;
use std::sync::{
  atomic::{AtomicBool, AtomicU64, Ordering},
  Arc, Mutex,
};
use std::sync::{mpsc, MutexGuard};
use std::{fs, thread};
use tauri::Manager;

struct ScanState {
  next_id: u64,
  active_id: Option<u64>,
  cancel_flag: Arc<AtomicBool>,
  watch_generation: u64,
}

#[derive(Serialize)]
struct DiskOverview {
  #[serde(rename = "rootPath")]
  root_path: String,
  #[serde(rename = "mountPoint")]
  mount_point: String,
  #[serde(rename = "volumeName")]
  volume_name: String,
  #[serde(rename = "totalBytes")]
  total_bytes: u64,
  #[serde(rename = "availableBytes")]
  available_bytes: u64,
  #[serde(rename = "usedBytes")]
  used_bytes: u64,
  #[serde(rename = "usedPercent")]
  used_percent: f64,
}

#[derive(Clone, Serialize)]
struct FsChangePayload {
  #[serde(rename = "scanId")]
  scan_id: u64,
  path: String,
  kind: String,
  size: Option<u64>,
  #[serde(rename = "logicalSize")]
  logical_size: Option<u64>,
}

#[derive(Default)]
struct FolderMeasure {
  size: u64,
  logical_size: u64,
  file_count: u64,
  folder_count: u64,
  unreadable_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderChildEntry {
  path: String,
  name: String,
  kind: String,
  size: u64,
  logical_size: u64,
  file_count: u64,
  folder_count: u64,
  unreadable_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderChildrenResponse {
  path: String,
  entries: Vec<FolderChildEntry>,
  total_bytes: u64,
  total_logical_bytes: u64,
  file_count: u64,
  folder_count: u64,
  unreadable_count: u64,
  from_cache: bool,
  stale: bool,
}

impl Default for ScanState {
  fn default() -> Self {
    Self {
      next_id: 1,
      active_id: None,
      cancel_flag: Arc::new(AtomicBool::new(false)),
      watch_generation: 0,
    }
  }
}

fn watch_generation(state: &MutexGuard<ScanState>) -> u64 {
  state.watch_generation
}

fn should_watch(app: &tauri::AppHandle, generation: u64) -> bool {
  let state = app.state::<Mutex<ScanState>>();
  let result = match state.lock() {
    Ok(state) => watch_generation(&state) == generation,
    Err(_) => true,
  };
  result
}

fn path_is_file(path: &Path) -> bool {
  match fs::symlink_metadata(path) {
    Ok(metadata) => metadata.is_file() && !metadata.file_type().is_symlink(),
    Err(_) => false,
  }
}

fn allocated_size(metadata: &fs::Metadata) -> u64 {
  #[cfg(target_family = "unix")]
  {
    metadata.blocks().saturating_mul(512)
  }
  #[cfg(not(target_family = "unix"))]
  {
    metadata.len()
  }
}

fn display_name(path: &Path) -> String {
  path
    .file_name()
    .map(|name| name.to_string_lossy().to_string())
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[derive(Default)]
struct MeasureAtomics {
  size: AtomicU64,
  logical_size: AtomicU64,
  file_count: AtomicU64,
  folder_count: AtomicU64,
  unreadable_count: AtomicU64,
}

fn measure_directory(path: &Path) -> FolderMeasure {
  let acc = Arc::new(MeasureAtomics::default());
  let worker = acc.clone();

  // jwalk reads each directory on a rayon worker thread, so the per-file
  // stat() calls (the bottleneck) run in parallel across the subtree.
  // Sizes/counts are tallied inside `process_read_dir`; directory-open and
  // entry-read failures surface as Err items in the main iterator and are
  // counted there to avoid double-counting.
  let walker = jwalk::WalkDir::new(path)
    .skip_hidden(false)
    .follow_links(false)
    .process_read_dir(move |_depth, _dir_path, _state, children| {
      for child in children.iter() {
        let entry = match child {
          Ok(entry) => entry,
          Err(_) => continue,
        };
        // jwalk invokes this once for the start dir's parent context, where
        // the root itself appears as a depth-0 child; skip it so the root
        // isn't counted as one of its own subfolders.
        if entry.depth() == 0 {
          continue;
        }
        let file_type = entry.file_type();
        if file_type.is_symlink() {
          continue;
        }
        if file_type.is_dir() {
          worker.folder_count.fetch_add(1, Ordering::Relaxed);
        } else if file_type.is_file() {
          match entry.metadata() {
            Ok(metadata) => {
              worker
                .size
                .fetch_add(allocated_size(&metadata), Ordering::Relaxed);
              worker
                .logical_size
                .fetch_add(metadata.len(), Ordering::Relaxed);
              worker.file_count.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
              worker.unreadable_count.fetch_add(1, Ordering::Relaxed);
            }
          }
        }
      }
    });

  for entry in walker {
    if entry.is_err() {
      acc.unreadable_count.fetch_add(1, Ordering::Relaxed);
    }
  }

  FolderMeasure {
    size: acc.size.load(Ordering::Relaxed),
    logical_size: acc.logical_size.load(Ordering::Relaxed),
    file_count: acc.file_count.load(Ordering::Relaxed),
    folder_count: acc.folder_count.load(Ordering::Relaxed),
    unreadable_count: acc.unreadable_count.load(Ordering::Relaxed),
  }
}

fn collect_folder_children(path: PathBuf) -> Result<FolderChildrenResponse, String> {
  let metadata = fs::symlink_metadata(&path).map_err(|_| "Path not found".to_string())?;
  if metadata.file_type().is_symlink() {
    return Err("Symlinks are skipped during folder sizing".to_string());
  }

  if metadata.is_file() {
    return Ok(FolderChildrenResponse {
      path: path.to_string_lossy().to_string(),
      entries: Vec::new(),
      total_bytes: allocated_size(&metadata),
      total_logical_bytes: metadata.len(),
      file_count: 1,
      folder_count: 0,
      unreadable_count: 0,
      from_cache: false,
      stale: false,
    });
  }

  if !metadata.is_dir() {
    return Err("Only folders and regular files can be sized".to_string());
  }

  let entries = fs::read_dir(&path).map_err(|_| "Unable to read folder".to_string())?;
  let mut children = Vec::new();
  let mut total_bytes = 0u64;
  let mut total_logical_bytes = 0u64;
  let mut file_count = 0u64;
  let mut folder_count = 0u64;
  let mut unreadable_count = 0u64;

  for entry in entries {
    let entry = match entry {
      Ok(entry) => entry,
      Err(_) => {
        unreadable_count = unreadable_count.saturating_add(1);
        continue;
      }
    };

    let file_type = match entry.file_type() {
      Ok(file_type) => file_type,
      Err(_) => {
        unreadable_count = unreadable_count.saturating_add(1);
        continue;
      }
    };

    if file_type.is_symlink() {
      continue;
    }

    let child_path = entry.path();
    let child_path_string = child_path.to_string_lossy().to_string();
    let name = display_name(&child_path);

    if file_type.is_dir() {
      let measure = measure_directory(&child_path);
      total_bytes = total_bytes.saturating_add(measure.size);
      total_logical_bytes = total_logical_bytes.saturating_add(measure.logical_size);
      file_count = file_count.saturating_add(measure.file_count);
      folder_count = folder_count
        .saturating_add(1)
        .saturating_add(measure.folder_count);
      unreadable_count = unreadable_count.saturating_add(measure.unreadable_count);
      children.push(FolderChildEntry {
        path: child_path_string,
        name,
        kind: "folder".to_string(),
        size: measure.size,
        logical_size: measure.logical_size,
        file_count: measure.file_count,
        folder_count: measure.folder_count,
        unreadable_count: measure.unreadable_count,
      });
      continue;
    }

    if !file_type.is_file() {
      continue;
    }

    let metadata = match entry.metadata() {
      Ok(metadata) => metadata,
      Err(_) => {
        unreadable_count = unreadable_count.saturating_add(1);
        continue;
      }
    };
    let size = allocated_size(&metadata);
    let logical_size = metadata.len();

    total_bytes = total_bytes.saturating_add(size);
    total_logical_bytes = total_logical_bytes.saturating_add(logical_size);
    file_count = file_count.saturating_add(1);
    children.push(FolderChildEntry {
      path: child_path_string,
      name,
      kind: "file".to_string(),
      size,
      logical_size,
      file_count: 1,
      folder_count: 0,
      unreadable_count: 0,
    });
  }

  children.sort_by(|a, b| {
    b.size
      .cmp(&a.size)
      .then_with(|| a.kind.cmp(&b.kind))
      .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
  });

  Ok(FolderChildrenResponse {
    path: path.to_string_lossy().to_string(),
    entries: children,
    total_bytes,
    total_logical_bytes,
    file_count,
    folder_count,
    unreadable_count,
    from_cache: false,
    stale: false,
  })
}

fn refresh_folder_cache(app: tauri::AppHandle, path: String) -> Result<FolderChildrenResponse, String> {
  let response = collect_folder_children(PathBuf::from(&path))?;
  cache::save_folder(&app, &response)?;
  let _ = app.emit_to("main", "folder_children_updated", response.clone());
  Ok(response)
}

fn start_fs_watcher(app: tauri::AppHandle, root: PathBuf, scan_id: u64, watch_generation: u64) {
  thread::spawn(move || {
    let (tx, rx) = mpsc::sync_channel(1024);
    let mut watcher: RecommendedWatcher = match notify::recommended_watcher(move |res| {
      let _ = tx.try_send(res);
    }) {
      Ok(watcher) => watcher,
      Err(_) => return,
    };

    if watcher.watch(&root, RecursiveMode::Recursive).is_err() {
      return;
    }

    for result in rx {
      if !should_watch(&app, watch_generation) {
        break;
      }

      let event = match result {
        Ok(event) => event,
        Err(_) => continue,
      };

      let kind = match event.kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => continue,
      };

      for path in event.paths {
        let path_string = path.to_string_lossy().to_string();
        let (event_kind, size, logical_size) = if kind == "remove" {
          ("remove", None, None)
        } else if !path.exists() {
          ("remove", None, None)
        } else if path_is_file(&path) {
          match fs::metadata(&path) {
            Ok(metadata) => (
              kind,
              Some(allocated_size(&metadata)),
              Some(metadata.len()),
            ),
            Err(_) => (kind, None, None),
          }
        } else {
          continue;
        };

        let payload = FsChangePayload {
          scan_id,
          path: path_string,
          kind: event_kind.to_string(),
          size,
          logical_size,
        };

        let _ = app.emit_to("main", "scan_fs_change", payload);
      }
    }
  });
}

#[cfg(target_os = "macos")]
fn mount_point_for_path(path: &PathBuf) -> Option<String> {
  let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
  let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
  let result = unsafe { libc::statfs(c_path.as_ptr(), &mut stats) };
  if result != 0 {
    return None;
  }
  let mount = unsafe { CStr::from_ptr(stats.f_mntonname.as_ptr()) };
  Some(mount.to_string_lossy().to_string())
}

#[cfg(target_os = "macos")]
fn volume_name_for_path(path: &PathBuf) -> Option<String> {
  #[repr(C)]
  #[derive(Copy, Clone)]
  struct AttrReference {
    attr_dataoffset: i32,
    attr_length: u32,
  }

  const ATTR_BIT_MAP_COUNT: u16 = 5;
  const ATTR_VOL_NAME: u32 = 0x00000001;

  let c_path = CString::new(path.as_os_str().as_bytes()).ok()?;
  let mut attrlist: libc::attrlist = unsafe { std::mem::zeroed() };
  attrlist.bitmapcount = ATTR_BIT_MAP_COUNT;
  attrlist.volattr = ATTR_VOL_NAME;

  let mut buffer = vec![0u8; 1024];
  let result = unsafe {
    libc::getattrlist(
      c_path.as_ptr(),
      &mut attrlist as *mut _ as *mut libc::c_void,
      buffer.as_mut_ptr() as *mut _,
      buffer.len(),
      0,
    )
  };

  if result != 0 || buffer.len() < 4 + std::mem::size_of::<AttrReference>() {
    return None;
  }

  let attr_ref = unsafe { ptr::read_unaligned(buffer.as_ptr().add(4) as *const AttrReference) };
  if attr_ref.attr_dataoffset < 0 {
    return None;
  }
  let offset = usize::try_from(attr_ref.attr_dataoffset).ok()?;
  let start = 4usize.checked_add(offset)?;
  let end = start.checked_add(attr_ref.attr_length as usize)?;
  if end > buffer.len() {
    return None;
  }
  let bytes = &buffer[start..end];
  let trimmed = if bytes.last() == Some(&0) {
    &bytes[..bytes.len().saturating_sub(1)]
  } else {
    bytes
  };
  Some(String::from_utf8_lossy(trimmed).to_string())
}

#[tauri::command]
fn start_scan(
  root_path: String,
  app: tauri::AppHandle,
  state: tauri::State<Mutex<ScanState>>,
) -> Result<u64, String> {
  let root = PathBuf::from(root_path);
  if !root.exists() {
    return Err("Path does not exist".to_string());
  }

  let (scan_id, cancel_flag) = {
    let mut state = state
      .lock()
      .map_err(|_| "Scan state lock poisoned".to_string())?;

    if state.active_id.is_some() {
      state.cancel_flag.store(true, Ordering::Relaxed);
    }

    let scan_id = state.next_id;
    state.next_id = state.next_id.wrapping_add(1);

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state.watch_generation = state.watch_generation.wrapping_add(1);
    state.cancel_flag = cancel_flag.clone();
    state.active_id = Some(scan_id);

    (scan_id, cancel_flag)
  };

  let watch_root = root.clone();
  let watch_generation = {
    let state = app.state::<Mutex<ScanState>>();
    state
      .lock()
      .map(|state| watch_generation(&state))
      .unwrap_or(0)
  };

  std::thread::spawn(move || {
    let cancelled =
      scanner::scan_directory(app.clone(), root, cancel_flag, DEFAULT_TOP_N, scan_id);

    let state = app.state::<Mutex<ScanState>>();
    if let Ok(mut state) = state.lock() {
      if state.active_id == Some(scan_id) {
        state.active_id = None;
      }
    };

    if !cancelled && should_watch(&app, watch_generation) {
      start_fs_watcher(app.clone(), watch_root, scan_id, watch_generation);
    }
  });

  Ok(scan_id)
}

#[tauri::command]
fn cancel_scan(scan_id: u64, state: tauri::State<Mutex<ScanState>>) -> Result<bool, String> {
  let mut state = state
    .lock()
    .map_err(|_| "Scan state lock poisoned".to_string())?;

  if state.active_id == Some(scan_id) {
    state.cancel_flag.store(true, Ordering::Relaxed);
    state.active_id = None;
    Ok(true)
  } else {
    Ok(false)
  }
}

#[tauri::command]
fn delete_file(path: String) -> Result<bool, String> {
  let path = PathBuf::from(path);
  let metadata = fs::symlink_metadata(&path).map_err(|_| "File not found".to_string())?;
  if !metadata.is_file() || metadata.file_type().is_symlink() {
    return Err("Only regular files can be deleted".to_string());
  }
  fs::remove_file(&path).map_err(|_| "Unable to delete file".to_string())?;
  Ok(true)
}

#[tauri::command]
fn clear_cache(app: tauri::AppHandle) -> Result<(), String> {
  cache::clear(&app)
}

#[tauri::command]
async fn folder_children(
  path: String,
  force_refresh: Option<bool>,
  app: tauri::AppHandle,
) -> Result<FolderChildrenResponse, String> {
  if force_refresh != Some(true) {
    if let Some(cached) = cache::load_folder(&app, &path)? {
      let refresh_app = app.clone();
      let refresh_path = path.clone();
      tauri::async_runtime::spawn_blocking(move || {
        let _ = refresh_folder_cache(refresh_app, refresh_path);
      });
      return Ok(cached);
    }
  }

  tauri::async_runtime::spawn_blocking(move || refresh_folder_cache(app, path))
    .await
    .map_err(|_| "Folder sizing task failed".to_string())?
}

#[tauri::command]
#[cfg(target_family = "unix")]
fn disk_overview(root_path: String) -> Result<DiskOverview, String> {
  let root = PathBuf::from(root_path.clone());
  let c_path = CString::new(root.as_os_str().as_bytes())
    .map_err(|_| "Invalid path for disk lookup".to_string())?;
  let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
  let result = unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) };

  if result != 0 {
    return Err("Unable to read disk usage".to_string());
  }

  let block_size = if stats.f_frsize > 0 {
    stats.f_frsize as u64
  } else {
    stats.f_bsize as u64
  };
  let total = stats.f_blocks as u64 * block_size;
  let available = stats.f_bavail as u64 * block_size;
  let used = total.saturating_sub(available);
  let used_percent = if total > 0 {
    (used as f64 / total as f64) * 100.0
  } else {
    0.0
  };

  #[cfg(target_os = "macos")]
  let mount_point = mount_point_for_path(&root).unwrap_or_else(|| root_path.clone());
  #[cfg(not(target_os = "macos"))]
  let mount_point = root_path.clone();

  #[cfg(target_os = "macos")]
  let volume_name = volume_name_for_path(&PathBuf::from(&mount_point))
    .unwrap_or_else(|| mount_point.clone());
  #[cfg(not(target_os = "macos"))]
  let volume_name = mount_point.clone();

  Ok(DiskOverview {
    root_path,
    mount_point,
    volume_name,
    total_bytes: total,
    available_bytes: available,
    used_bytes: used,
    used_percent,
  })
}

#[tauri::command]
#[cfg(not(target_family = "unix"))]
fn disk_overview(_root_path: String) -> Result<DiskOverview, String> {
  Err("Disk usage not supported on this platform".to_string())
}

fn main() {
  tauri::Builder::default()
    .manage(Mutex::new(ScanState::default()))
    .invoke_handler(tauri::generate_handler![
      start_scan,
      cancel_scan,
      delete_file,
      folder_children,
      clear_cache,
      disk_overview
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(all(test, target_family = "unix"))]
mod measure_tests {
  use super::{allocated_size, measure_directory, FolderMeasure};
  use std::collections::VecDeque;
  use std::fs;
  use std::path::{Path, PathBuf};

  // Reference serial walk: a faithful copy of the pre-jwalk algorithm,
  // used purely to assert the parallel impl produces identical counts.
  fn measure_serial(path: &Path) -> FolderMeasure {
    let mut measure = FolderMeasure::default();
    let mut dirs = VecDeque::from([path.to_path_buf()]);

    while let Some(dir) = dirs.pop_front() {
      let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => {
          measure.unreadable_count += 1;
          continue;
        }
      };
      for entry in entries {
        let entry = match entry {
          Ok(entry) => entry,
          Err(_) => {
            measure.unreadable_count += 1;
            continue;
          }
        };
        let file_type = match entry.file_type() {
          Ok(file_type) => file_type,
          Err(_) => {
            measure.unreadable_count += 1;
            continue;
          }
        };
        if file_type.is_symlink() {
          continue;
        }
        if file_type.is_dir() {
          measure.folder_count += 1;
          dirs.push_back(entry.path());
          continue;
        }
        if !file_type.is_file() {
          continue;
        }
        match entry.metadata() {
          Ok(metadata) => {
            measure.file_count += 1;
            measure.size += allocated_size(&metadata);
            measure.logical_size += metadata.len();
          }
          Err(_) => measure.unreadable_count += 1,
        }
      }
    }
    measure
  }

  fn assert_match(path: &Path) {
    let parallel = measure_directory(path);
    let serial = measure_serial(path);
    assert_eq!(parallel.size, serial.size, "size mismatch at {path:?}");
    assert_eq!(
      parallel.logical_size, serial.logical_size,
      "logical_size mismatch at {path:?}"
    );
    assert_eq!(
      parallel.file_count, serial.file_count,
      "file_count mismatch at {path:?}"
    );
    assert_eq!(
      parallel.folder_count, serial.folder_count,
      "folder_count mismatch at {path:?}"
    );
    assert_eq!(
      parallel.unreadable_count, serial.unreadable_count,
      "unreadable_count mismatch at {path:?}"
    );
  }

  #[test]
  fn matches_reference_on_synthetic_tree() {
    let root = std::env::temp_dir().join(format!("chonky-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("a/b/c")).unwrap();
    fs::create_dir_all(root.join("a/empty")).unwrap();
    fs::create_dir_all(root.join("d")).unwrap();
    fs::write(root.join("top.bin"), vec![0u8; 4096]).unwrap();
    fs::write(root.join("a/one.bin"), vec![1u8; 100]).unwrap();
    fs::write(root.join("a/b/two.bin"), vec![2u8; 8192]).unwrap();
    fs::write(root.join("a/b/c/three.bin"), vec![3u8; 1]).unwrap();
    fs::write(root.join("d/four.bin"), vec![4u8; 50000]).unwrap();
    std::os::unix::fs::symlink(root.join("top.bin"), root.join("link.bin")).unwrap();
    std::os::unix::fs::symlink(root.join("a"), root.join("a-link")).unwrap();

    assert_match(&root);

    let result = measure_directory(&root);
    assert_eq!(result.file_count, 5, "expected 5 real files");
    assert_eq!(result.folder_count, 5, "expected 5 real subdirs");

    fs::remove_dir_all(&root).unwrap();
  }

  // Opt-in check against a real folder: CHONKY_TEST_DIR=/some/path cargo test -- --nocapture
  #[test]
  fn matches_reference_on_real_dir() {
    let Ok(dir) = std::env::var("CHONKY_TEST_DIR") else {
      return;
    };
    let path = PathBuf::from(dir);
    assert_match(&path);
    let m = measure_directory(&path);
    println!(
      "measure({path:?}) -> disk={} bytes, logical={} bytes, files={}, folders={}, unreadable={}",
      m.size, m.logical_size, m.file_count, m.folder_count, m.unreadable_count
    );
  }
}
