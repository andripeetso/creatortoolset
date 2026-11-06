/**
 * The Media Library's SQLite schema: $DATA_DIR/library/library.db (tasks/media-library-plan.md, section 2).
 * Each entry is one numbered migration; db.ts runs the ones past `PRAGMA user_version`, once each.
 * Append only: a shipped migration is never edited.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE libraries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('local','s3','bunny')),
    storage_config TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    kind TEXT NOT NULL CHECK (kind IN ('video','image','audio','doc')),
    title TEXT NOT NULL,
    current_version_id TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    trashed_at INTEGER,
    UNIQUE (id, library_id)
  );
  CREATE INDEX assets_library ON assets(library_id, created_at DESC);

  CREATE TABLE asset_versions (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    n INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    source_path TEXT,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    mime TEXT,
    probe TEXT,
    state TEXT NOT NULL CHECK (state IN ('processing','ready','failed','missing')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (asset_id, n)
  );
  CREATE INDEX versions_sha ON asset_versions(sha256);

  CREATE TABLE derivatives (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    kind TEXT NOT NULL CHECK (kind IN ('thumb','sprite','proxy','wave','audio','fingerprint')),
    storage_key TEXT,
    inline TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (version_id, kind)
  );

  CREATE TABLE collections (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    parent_id TEXT REFERENCES collections(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('manual','smart')),
    query TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id TEXT NOT NULL REFERENCES collections(id),
    asset_id TEXT NOT NULL REFERENCES assets(id),
    position REAL NOT NULL,
    added_by TEXT NOT NULL,
    PRIMARY KEY (collection_id, asset_id)
  );

  CREATE TABLE asset_tags (
    asset_id TEXT NOT NULL REFERENCES assets(id),
    tag TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user','ai')),
    PRIMARY KEY (asset_id, tag)
  );

  CREATE TABLE descriptions (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    source TEXT NOT NULL CHECK (source IN ('user','ai')),
    text TEXT NOT NULL,
    provider TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (version_id, source)
  );

  CREATE TABLE transcripts (
    version_id TEXT PRIMARY KEY REFERENCES asset_versions(id),
    provider TEXT NOT NULL,
    language TEXT,
    text TEXT NOT NULL,
    segments TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE search_assets USING fts5(
    asset_id UNINDEXED, library_id UNINDEXED, title, tags, description, tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE VIRTUAL TABLE search_segments USING fts5(
    version_id UNINDEXED, seg UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE embeddings (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    chunk INTEGER NOT NULL,
    start_s REAL NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (version_id, chunk, model)
  );

  CREATE TABLE derived_from (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    source_version_id TEXT NOT NULL REFERENCES asset_versions(id),
    note TEXT,
    PRIMARY KEY (version_id, source_version_id)
  );

  CREATE TABLE shares (
    token_hash TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('asset','version','collection')),
    target_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('view','download','comment')),
    password_hash TEXT,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    created_by TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    staging_path TEXT NOT NULL,
    replaces_asset_id TEXT,
    collection_id TEXT,
    expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','finishing','done','failed'))
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id TEXT NOT NULL,
    version_id TEXT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','needs_key')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    actor TEXT,
    error TEXT,
    UNIQUE (version_id, kind)
  );

  CREATE TABLE watch_seen (
    library_id TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    version_id TEXT,
    PRIMARY KEY (library_id, path)
  );

  CREATE TABLE usage_daily (
    library_id TEXT NOT NULL,
    day TEXT NOT NULL,
    stored_bytes INTEGER NOT NULL,
    egress_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (library_id, day)
  );
  `,
];
