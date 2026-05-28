use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{FolderChildEntry, FolderChildrenResponse};

const DB_FILE_NAME: &str = "folder-cache.sqlite3";

fn now_unix_seconds() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_secs() as i64)
    .unwrap_or(0)
}

fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path_resolver()
    .app_data_dir()
    .ok_or_else(|| "Unable to resolve app data directory".to_string())?;
  std::fs::create_dir_all(&dir).map_err(|_| "Unable to create cache directory".to_string())?;
  Ok(dir.join(DB_FILE_NAME))
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
  let connection = Connection::open(cache_path(app)?)
    .map_err(|err| format!("Unable to open folder cache: {err}"))?;
  connection
    .execute_batch(
      "
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS folder_cache (
        path TEXT PRIMARY KEY,
        total_bytes INTEGER NOT NULL,
        total_logical_bytes INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        folder_count INTEGER NOT NULL,
        unreadable_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folder_entries (
        parent_path TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        logical_size INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        folder_count INTEGER NOT NULL,
        unreadable_count INTEGER NOT NULL,
        PRIMARY KEY (parent_path, path)
      );

      CREATE INDEX IF NOT EXISTS idx_folder_entries_parent_size
        ON folder_entries(parent_path, size DESC);
      ",
    )
    .map_err(|err| format!("Unable to initialize folder cache: {err}"))?;
  Ok(connection)
}

pub fn load_folder(
  app: &tauri::AppHandle,
  path: &str,
) -> Result<Option<FolderChildrenResponse>, String> {
  let connection = open(app)?;
  let mut summary_statement = connection
    .prepare(
      "
      SELECT total_bytes, total_logical_bytes, file_count, folder_count, unreadable_count
      FROM folder_cache
      WHERE path = ?1
      ",
    )
    .map_err(|err| format!("Unable to read folder cache: {err}"))?;

  let summary = match summary_statement.query_row(params![path], |row| {
    Ok((
      row.get::<_, u64>(0)?,
      row.get::<_, u64>(1)?,
      row.get::<_, u64>(2)?,
      row.get::<_, u64>(3)?,
      row.get::<_, u64>(4)?,
    ))
  }) {
    Ok(summary) => summary,
    Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
    Err(err) => return Err(format!("Unable to read folder cache: {err}")),
  };

  let mut entries_statement = connection
    .prepare(
      "
      SELECT path, name, kind, size, logical_size, file_count, folder_count, unreadable_count
      FROM folder_entries
      WHERE parent_path = ?1
      ORDER BY size DESC, kind ASC, lower(name) ASC
      ",
    )
    .map_err(|err| format!("Unable to read cached folder entries: {err}"))?;

  let entries = entries_statement
    .query_map(params![path], |row| {
      Ok(FolderChildEntry {
        path: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        size: row.get(3)?,
        logical_size: row.get(4)?,
        file_count: row.get(5)?,
        folder_count: row.get(6)?,
        unreadable_count: row.get(7)?,
      })
    })
    .map_err(|err| format!("Unable to read cached folder entries: {err}"))?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| format!("Unable to read cached folder entries: {err}"))?;

  Ok(Some(FolderChildrenResponse {
    path: path.to_string(),
    entries,
    total_bytes: summary.0,
    total_logical_bytes: summary.1,
    file_count: summary.2,
    folder_count: summary.3,
    unreadable_count: summary.4,
    from_cache: true,
    stale: true,
  }))
}

pub fn save_folder(
  app: &tauri::AppHandle,
  response: &FolderChildrenResponse,
) -> Result<(), String> {
  let mut connection = open(app)?;
  let transaction = connection
    .transaction()
    .map_err(|err| format!("Unable to update folder cache: {err}"))?;

  transaction
    .execute(
      "
      INSERT INTO folder_cache (
        path, total_bytes, total_logical_bytes, file_count, folder_count, unreadable_count, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(path) DO UPDATE SET
        total_bytes = excluded.total_bytes,
        total_logical_bytes = excluded.total_logical_bytes,
        file_count = excluded.file_count,
        folder_count = excluded.folder_count,
        unreadable_count = excluded.unreadable_count,
        updated_at = excluded.updated_at
      ",
      params![
        response.path,
        response.total_bytes,
        response.total_logical_bytes,
        response.file_count,
        response.folder_count,
        response.unreadable_count,
        now_unix_seconds()
      ],
    )
    .map_err(|err| format!("Unable to update folder cache: {err}"))?;

  transaction
    .execute(
      "DELETE FROM folder_entries WHERE parent_path = ?1",
      params![response.path],
    )
    .map_err(|err| format!("Unable to update folder cache: {err}"))?;

  {
    let mut statement = transaction
      .prepare(
        "
        INSERT INTO folder_entries (
          parent_path, path, name, kind, size, logical_size, file_count, folder_count, unreadable_count
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
      )
      .map_err(|err| format!("Unable to update folder cache: {err}"))?;

    for entry in &response.entries {
      statement
        .execute(params![
          response.path,
          entry.path,
          entry.name,
          entry.kind,
          entry.size,
          entry.logical_size,
          entry.file_count,
          entry.folder_count,
          entry.unreadable_count,
        ])
        .map_err(|err| format!("Unable to update folder cache: {err}"))?;
    }
  }

  transaction
    .commit()
    .map_err(|err| format!("Unable to update folder cache: {err}"))?;
  Ok(())
}
