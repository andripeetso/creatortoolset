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
  // 2: who made a collection (folders are collections; a member edits their own, the owner any)
  `
  ALTER TABLE collections ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
  `,
  // 3: storage is 'local' or 's3' only (a third kind in migration 1 had no backend). SQLite cannot change a CHECK: the table is rebuilt (foreign keys are
  // off while migrations run, db.ts); the child tables still name libraries, so their keys point at the new one
  `
  CREATE TABLE libraries_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('local','s3')),
    storage_config TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  INSERT INTO libraries_new SELECT id, workspace_id, name, storage_kind, storage_config, settings, created_at FROM libraries;
  DROP TABLE libraries;
  ALTER TABLE libraries_new RENAME TO libraries;
  `,
  // 4: the AI Editor. Word timings with fillers ([{w, s, e, c}], seconds) beside the segments; and its own job table with the
  // shape of `jobs`, so jobs.ts runs on both. version_id is "<editId>:<variant>" ("<editId>:" for a whole-edit step), never
  // NULL (UNIQUE treats NULLs as distinct); edit_id is derived from it; library_id holds the edit's workspace id.
  `
  ALTER TABLE transcripts ADD COLUMN words TEXT;
  CREATE TABLE edit_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','needs_key')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    actor TEXT,
    error TEXT,
    edit_id TEXT GENERATED ALWAYS AS (substr(version_id, 1, instr(version_id, ':') - 1)) VIRTUAL,
    UNIQUE (version_id, kind)
  );
  CREATE INDEX edit_jobs_edit ON edit_jobs(edit_id);
  `,
  // 5: storage may also be a Bunny Storage zone. Same table rebuild as migration 3 (foreign keys are off while migrations run)
  `
  CREATE TABLE libraries_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    storage_kind TEXT NOT NULL CHECK (storage_kind IN ('local','s3','bunny')),
    storage_config TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  INSERT INTO libraries_new SELECT id, workspace_id, name, storage_kind, storage_config, settings, created_at FROM libraries;
  DROP TABLE libraries;
  ALTER TABLE libraries_new RENAME TO libraries;
  `,
  // 6: pieces. A piece groups versions (or, later, external refs such as catalog clips) with one winner, one post
  // description and any number of postings per item. Finals is the pieces of a collection. Deleting a version (the trash
  // purge) takes its piece items and their postings with it; deleting a collection leaves its pieces without one.
  // The winner is one row per piece (the partial unique index); a version is in a piece once.
  `
  CREATE TABLE pieces (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
    label TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pieces_library ON pieces(library_id, created_at);

  CREATE TABLE piece_items (
    id TEXT PRIMARY KEY,
    piece_id TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
    version_id TEXT REFERENCES asset_versions(id) ON DELETE CASCADE,
    external_ref TEXT,
    label TEXT,
    position REAL NOT NULL,
    winner INTEGER NOT NULL DEFAULT 0 CHECK (winner IN (0, 1)),
    post_description TEXT,
    CHECK ((version_id IS NULL) <> (external_ref IS NULL))
  );
  CREATE UNIQUE INDEX piece_items_version ON piece_items(piece_id, version_id) WHERE version_id IS NOT NULL;
  CREATE UNIQUE INDEX piece_items_winner ON piece_items(piece_id) WHERE winner = 1;

  CREATE TABLE postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_item_id TEXT NOT NULL REFERENCES piece_items(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    url TEXT,
    posted_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  );
  CREATE INDEX postings_item ON postings(piece_item_id);
  `,
  // 7: the device that holds an AI Editor step (edit_jobs only; NULL = the server or nobody). A device that goes quiet
  // loses the steps it holds (engine.ts releaseQuietDevices), and its beats, done and fail are checked against it.
  `
  ALTER TABLE edit_jobs ADD COLUMN device TEXT;
  `,
  // 8: per-collection grants (grants.ts): the library's owner shares a collection with an account. No row, no access.
  `
  CREATE TABLE library_grants (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, username)
  );
  CREATE INDEX library_grants_user ON library_grants(username);
  `,
  // 9: a direct upload (routes.ts, bucket libraries) has no staged file; this is its multipart upload id in the bucket
  `
  ALTER TABLE uploads ADD COLUMN direct_upload_id TEXT;
  `,
  // 10: a share can point at a piece (Finals). SQLite cannot change a CHECK: the shares table is rebuilt, as in migration 3
  `
  CREATE TABLE shares_new (
    token_hash TEXT PRIMARY KEY,
    library_id TEXT NOT NULL REFERENCES libraries(id),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('asset','version','collection','piece')),
    target_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('view','download','comment')),
    password_hash TEXT,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    views INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO shares_new SELECT token_hash, library_id, target_kind, target_id, scope, password_hash, created_by, expires_at, views FROM shares;
  DROP TABLE shares;
  ALTER TABLE shares_new RENAME TO shares;
  `,
  // 11: external refs (refs.ts). A clip or group a library source holds (a source's integer ids, for one) gets one public id
  // that pieces and Workshop links keep, so a link made before a move still opens after it. The source's own id stays here,
  // never in a URL; there is no version and no file, so the source serves its media and the policies decide who sees it.
  `
  CREATE TABLE external_refs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (source, kind, external_id)
  );
  `,
  // 12: a piece's cover (Finals). The owner picks a frame of one of its versions (or a still): cover_key is the JPEG it
  // became, cover_version_id the version it came from (that version's visibility decides who sees the cover), cover_at
  // the stamp in its URL, so a new pick is a new address. NULL = the automatic cover (the winner's thumbnail).
  `
  ALTER TABLE pieces ADD COLUMN cover_key TEXT;
  ALTER TABLE pieces ADD COLUMN cover_version_id TEXT;
  ALTER TABLE pieces ADD COLUMN cover_at INTEGER;
  `,
  // 13: a Finals piece in the Workshop (its versions get post descriptions in the linked session's piece, or its
  // main piece when no docId), and the piece's trash (trashed_at set = in the trash; restore clears it).
  `
  ALTER TABLE pieces ADD COLUMN workshop_session TEXT;
  ALTER TABLE pieces ADD COLUMN workshop_doc TEXT;
  ALTER TABLE pieces ADD COLUMN trashed_at INTEGER;
  `,
  // 14: the asked-once ledger for a Finals version's AI post description (FINALS_AUTO_DESCRIBE): set once the turn ran.
  `
  ALTER TABLE piece_items ADD COLUMN describe_asked_at INTEGER;
  `,
  // 15: when a job last started and finished (ms), so the library can say how long its steps take here (estimate.ts)
  `
  ALTER TABLE jobs ADD COLUMN started_at INTEGER;
  ALTER TABLE jobs ADD COLUMN done_at INTEGER;
  ALTER TABLE edit_jobs ADD COLUMN started_at INTEGER;
  ALTER TABLE edit_jobs ADD COLUMN done_at INTEGER;
  `,
  // 16: A-roll and B-roll (roll.ts): the clip's roll, what it was filed as ('a' for good, 'none' for finished work), the
  // AI's answer. The A-roll folder the AI Editor made (top level, plain, videos only) becomes the smart folder of the
  // clips sorted A-roll and its videos are filed as A-roll; its item rows stay, unread. A folder of that name holding
  // anything else stays as it is. Exports saved into the library before are finished work
  `
  ALTER TABLE assets ADD COLUMN roll TEXT;
  ALTER TABLE assets ADD COLUMN filed_roll TEXT;
  ALTER TABLE descriptions ADD COLUMN roll TEXT;
  UPDATE collections SET kind = 'smart', query = '{"roll":"a"}' WHERE kind = 'manual' AND parent_id IS NULL AND name = 'A-roll'
    AND NOT EXISTS (SELECT 1 FROM collection_items i JOIN assets a ON a.id = i.asset_id WHERE i.collection_id = collections.id AND a.kind <> 'video');
  UPDATE assets SET filed_roll = 'a' WHERE kind = 'video' AND id IN (SELECT i.asset_id FROM collection_items i JOIN collections c ON c.id = i.collection_id
    WHERE c.kind = 'smart' AND c.query = '{"roll":"a"}');
  UPDATE assets SET filed_roll = 'none' WHERE id IN (SELECT v.asset_id FROM derived_from f JOIN asset_versions v ON v.id = f.version_id WHERE f.note = 'export');
  `,
  // 17: the speech model a transcript made on the person's own computer came from (provider 'computer'): the AI Editor
  // hears a clip again when its row picks another model (editor/analyze.ts)
  `ALTER TABLE transcripts ADD COLUMN model TEXT;`,
  // 18: photos were placed from a video's location tag only, so each got country ""; placeUnplaced reads their EXIF once
  `UPDATE asset_versions SET probe = json_remove(probe, '$.country')
     WHERE json_extract(probe, '$.country') = '' AND asset_id IN (SELECT id FROM assets WHERE kind = 'image');`,
  // 19: a file indexed where it is on a person's Mac, for a server elsewhere (routes.ts on-mac): its path there and the
  // Mac's device id. The server holds only what the Mac made (probe, pictures); source_key is "mac:<version id>", no blob
  `
  ALTER TABLE asset_versions ADD COLUMN mac_path TEXT;
  ALTER TABLE asset_versions ADD COLUMN mac_device TEXT;
  `,
  // 20: where an uploaded file is on the computer it came from (its path, the Mac's device id), sent with the upload:
  // a library that keeps only proxies deletes the original once its proxy is made and keeps this place (worker.ts dropOriginal)
  `
  ALTER TABLE uploads ADD COLUMN from_path TEXT;
  ALTER TABLE uploads ADD COLUMN from_device TEXT;
  ALTER TABLE asset_versions ADD COLUMN from_path TEXT;
  ALTER TABLE asset_versions ADD COLUMN from_device TEXT;
  `,
  // 21: shot descriptions (tasks/flywheel/PLAN.md stage 2): one line per stretch of a video that isn't a talking take,
  // written by the person's AI with the workspace's context (look.ts); a line they write themselves (source 'user') wins.
  // stretch_notes: what the person said in an edit about the shot that stretch was in, kept with the footage so later
  // edits read it beside the line (a, b kept so a note survives the stretches being found again). descriptions gain
  // what kind of footage the clip is and the context stamp they were written under.
  `
  CREATE TABLE stretches (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    seg INTEGER NOT NULL,
    a REAL NOT NULL,
    b REAL NOT NULL,
    motion REAL NOT NULL,
    action INTEGER,
    clear INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    text TEXT NOT NULL DEFAULT '',
    ph TEXT,
    source TEXT NOT NULL DEFAULT 'ai',
    stamp TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (version_id, seg, source)
  );
  CREATE VIRTUAL TABLE search_stretches USING fts5(
    version_id UNINDEXED, seg UNINDEXED, text, tags, tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TABLE stretch_notes (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    a REAL NOT NULL,
    b REAL NOT NULL,
    text TEXT NOT NULL,
    edit_id TEXT NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX stretch_notes_version ON stretch_notes(version_id);
  ALTER TABLE descriptions ADD COLUMN kind TEXT;
  ALTER TABLE descriptions ADD COLUMN stamp TEXT;
  `,
  // 22: a video's shot descriptions keep their contact sheets ('looksheets', one JSON of JPEGs: stretches.ts), so they
  // can be written again under a new context without reading the video. SQLite cannot change a CHECK: the table is
  // rebuilt as in migration 3
  `
  CREATE TABLE derivatives_new (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    kind TEXT NOT NULL CHECK (kind IN ('thumb','sprite','proxy','wave','audio','fingerprint','looksheets')),
    storage_key TEXT,
    inline TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (version_id, kind)
  );
  INSERT INTO derivatives_new SELECT version_id, kind, storage_key, inline, bytes FROM derivatives;
  DROP TABLE derivatives;
  ALTER TABLE derivatives_new RENAME TO derivatives;
  `,
  // 23: a folder's place in the order the owner dragged the tabs into; none yet: after the placed ones, oldest first
  `ALTER TABLE collections ADD COLUMN position INTEGER;`,
  // 24: smart folders (smart.ts). A plain folder with a rule (the person's own words on what goes in it) is filled by the
  // AI: its clips are real items, by_ai = 1 for the ones it filed. folder_out keeps the clips the person took out of one,
  // so they are never filed there again
  `
  ALTER TABLE collections ADD COLUMN rule TEXT;
  ALTER TABLE collection_items ADD COLUMN by_ai INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE folder_out (
    collection_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    PRIMARY KEY (collection_id, asset_id)
  );
  `,
  // 25: every version's quick fingerprint (SHA-256 over the size, the first and the last MiB: work/files.ts quickPrint, the
  // Mac's the same), so a moved original is found again by it (locate.ts) and a computer finds its own copy. A file
  // indexed on a Mac kept it in sha256 ("mac:<quick>"); an upload gets it at its probe, older ones by locate.ts backfillQuick
  `
  ALTER TABLE asset_versions ADD COLUMN quick TEXT;
  UPDATE asset_versions SET quick = substr(sha256, 5) WHERE sha256 LIKE 'mac:%';
  `,
  // 26: what a phone made of a video itself, sent with its upload's start (derived.ts Made: quick fingerprint, card
  // picture, a 720p copy's original probe), kept until the upload finishes and it is filed
  `
  ALTER TABLE uploads ADD COLUMN made TEXT;
  `,
  // 27: here or away (places.ts). A version's original is at a root (a share or a volume, contracts/places.ts rootKey) and
  // a root path inside it, the same for every computer; NULL until known (places.ts backfillRoots). version_places: where
  // one computer last read the file, or found it gone; only that computer's owner sees or changes the row. mac_path and
  // mac_device stay as where it was first indexed. library_moves: the last reconnects, one row per folder change (device
  // '' for a move on the root itself, everyone's; else the computer that found its copies)
  `
  ALTER TABLE asset_versions ADD COLUMN root TEXT;
  ALTER TABLE asset_versions ADD COLUMN root_rel TEXT;
  CREATE TABLE version_places (
    version_id TEXT NOT NULL,
    device TEXT NOT NULL,
    path TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL,
    gone_at INTEGER,
    PRIMARY KEY (version_id, device)
  );
  CREATE INDEX version_places_device ON version_places(device);
  INSERT INTO version_places (version_id, device, path, confirmed_at)
    SELECT id, mac_device, mac_path, created_at FROM asset_versions WHERE mac_path IS NOT NULL AND mac_device IS NOT NULL;
  CREATE TABLE library_moves (
    library_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('moved','found')),
    device TEXT NOT NULL,
    root_key TEXT NOT NULL,
    root TEXT,
    from_prefix TEXT NOT NULL,
    to_prefix TEXT NOT NULL,
    count INTEGER NOT NULL,
    at INTEGER NOT NULL,
    UNIQUE (library_id, kind, device, root_key, from_prefix, to_prefix)
  );
  `,
  // 28: the level (contracts LOOK_LEVELS) a version's stretches were found at: stretches of another level than the
  // library's are found again when its shots are described (shots.ts), never matched to that level's lines. NULL: standard
  `ALTER TABLE asset_versions ADD COLUMN look_level TEXT;`,
  // 29: a video's timeline (timeline.ts): what happens when, from Gemini watching it with its sound. `events` JSON
  // (contracts TimelineEvent[]), the level and model it was made at; `error` when the watch failed (tried again a day
  // later). search_timeline holds each event's words with its start, so a search finds the moment
  `
  CREATE TABLE timelines (
    version_id TEXT PRIMARY KEY REFERENCES asset_versions(id),
    events TEXT NOT NULL DEFAULT '[]',
    level TEXT,
    model TEXT,
    error TEXT,
    at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE search_timeline USING fts5(
    version_id UNINDEXED, a UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  // 30: search by picture (pictures.ts): a vector of what each shot shows, by the stretch it is the middle of (seg as in
  // stretches) or -1 for the card picture; start_s is where the hit opens. An empty vec: no picture could be read
  `
  CREATE TABLE pictures (
    version_id TEXT NOT NULL REFERENCES asset_versions(id),
    seg INTEGER NOT NULL,
    start_s REAL NOT NULL,
    model TEXT NOT NULL,
    vec BLOB NOT NULL,
    PRIMARY KEY (version_id, seg)
  );
  `,
  // 31: how well each stretch is taken, measured where the picture is read (look.ts qualityOf): 0..1, and its flaws as a
  // JSON list ("blurry", "too dark", "shaky"). NULL: not measured (a picture read on a computer that sends no measures)
  `
  ALTER TABLE stretches ADD COLUMN quality REAL;
  ALTER TABLE stretches ADD COLUMN flaws TEXT;
  `,
  // 32: what found the cuts between a version's stretches (storeStretches): cuts.ts CUTS_BY_MODEL where a graphics card
  // ran the cut model, NULL where look.ts cutsOf measured them. A library can hold both; a version is read again only
  // when its shots are asked for again
  `ALTER TABLE asset_versions ADD COLUMN cuts_by TEXT;`,
  // 33: where a sound the app added came from (api/library/sfx.ts): its page, its licence and its author. Append only: a
  // row is written once, when the sound goes in, and never changed
  `
  CREATE TABLE asset_sources (
    asset_id TEXT NOT NULL REFERENCES assets(id),
    url TEXT NOT NULL,
    license TEXT NOT NULL,
    author TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (asset_id, url)
  );
  `,
  // 34: what the AI learned from the person's own tags (learn.ts): per library tag, how to recognise it, written from
  // the clips the person gave it (`clips`: their ids, so it is learned again only when that set changes; `seen` 0: a tag
  // for something no picture shows, never suggested). tag_rejections: an AI tag the person took off a clip, never given
  // to that clip again
  `
  CREATE TABLE tag_notes (
    library_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    note TEXT NOT NULL,
    seen INTEGER NOT NULL DEFAULT 1,
    clips TEXT NOT NULL,
    made_at INTEGER NOT NULL,
    PRIMARY KEY (library_id, tag)
  );
  CREATE TABLE tag_rejections (
    asset_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (asset_id, tag)
  );
  `,
  // 35: copies of a library in folders on its owner's computers (copies.ts). state is the computer's last word on the
  // folder; checked_at its last check of the files there; retry_at holds its jobs back after a reconnect or a full disk.
  // copy_files: each file in a copy, by version id (or a plug-in item's key), at the path it was put at; a row with
  // copied_at NULL is a try that failed (error), tried again an hour after tried_at
  `
  CREATE TABLE library_copies (
    id TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    device TEXT NOT NULL,
    path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','ok','reconnect','full')),
    last_seen INTEGER,
    free_bytes INTEGER,
    checked_at INTEGER,
    retry_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (device, path)
  );
  CREATE INDEX library_copies_library ON library_copies(library_id);
  CREATE TABLE copy_files (
    copy_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    rel_path TEXT,
    size INTEGER,
    sha256 TEXT,
    copied_at INTEGER,
    error TEXT,
    tried_at INTEGER,
    PRIMARY KEY (copy_id, version_id)
  );
  `,
  // 36: copying between computers (copies.ts send): the original a computer sent for a copy that only another computer
  // can write, kept on the store until every copy has it; storage_key NULL with error is a send that failed, asked again
  // an hour after tried_at. notice_at: when the library's owner was told a copy has taken nothing for two weeks
  `
  CREATE TABLE copy_sends (
    version_id TEXT PRIMARY KEY,
    storage_key TEXT,
    bytes INTEGER,
    sha256 TEXT,
    error TEXT,
    tried_at INTEGER,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE library_copies ADD COLUMN notice_at INTEGER;
  `,
  // 37: which computer holds a library job it claimed (its device id) and that claim's id (work/library-package.ts): a
  // restart of this server keeps the holder, and a computer's beat, file or result counts only on the claim it holds
  `
  ALTER TABLE jobs ADD COLUMN held_by TEXT;
  ALTER TABLE jobs ADD COLUMN claim_id TEXT;
  `,
  // 38: one place record per computer, kind and folder (local first, P1). version_places is rebuilt: its key was (version,
  // device), so one computer could not hold an original and a proxy, or a file in two folders. state is the computer's
  // last word (contracts/places.ts PlaceState); a row from before is 'unchecked' until a scan reads the file again, so it
  // is never "On this computer" by itself. full_sha256: the server's own file read whole (removal guard, whereis.ts).
  // device_alias: a computer paired again with a new id (lib/devices.ts pairDevice); its rows move to the new id.
  // A quick fingerprint of '' (a read that failed) is tried again
  `
  CREATE TABLE version_places_v2 (
    version_id TEXT NOT NULL,
    device TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'original' CHECK (kind IN ('original','proxy')),
    folder_id TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    bytes INTEGER,
    mtime INTEGER,
    quick TEXT,
    sha256 TEXT,
    state TEXT NOT NULL DEFAULT 'unchecked' CHECK (state IN ('verified','found','gone','unchecked')),
    source TEXT,
    confirmed_at INTEGER,
    checked_at INTEGER,
    verified_at INTEGER,
    gone_at INTEGER,
    PRIMARY KEY (version_id, device, kind, folder_id)
  );
  INSERT INTO version_places_v2 (version_id, device, kind, folder_id, path, confirmed_at, gone_at, state, source)
    SELECT version_id, device, 'original', '', path, confirmed_at, gone_at, 'unchecked', 'migrated' FROM version_places;
  DROP TABLE version_places;
  ALTER TABLE version_places_v2 RENAME TO version_places;
  CREATE INDEX version_places_device ON version_places(device);
  CREATE INDEX version_places_folder ON version_places(device, folder_id);
  ALTER TABLE asset_versions ADD COLUMN full_sha256 TEXT;
  CREATE TABLE device_alias (
    old_id TEXT PRIMARY KEY,
    new_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  UPDATE asset_versions SET quick = NULL WHERE quick = '';
  `,
  // Finals upload written down where it was never set (local-first plan DM6, decision 6): "all", what it read as
  `UPDATE libraries SET settings = json_set(settings, '$.finalsUpload', 'all') WHERE json_extract(settings, '$.finalsUpload') IS NULL;`,
  // an upload the iPhone app sent to the person's computers ("phone", routes.ts): taken under Upload none too
  `ALTER TABLE uploads ADD COLUMN origin TEXT;`,
  // the upload's origin kept on its version: a version the iPhone app sent is the only original held for a computer (upload-gate.ts mayServe)
  `ALTER TABLE asset_versions ADD COLUMN origin TEXT;`,
  // a folder Smart folders made for one shoot (shoots.ts): JSON {label, country, place, name}, name = the name it was given,
  // so one the person renamed is never renamed again
  `ALTER TABLE collections ADD COLUMN shoot TEXT;`,
  // a strip's frame size (media/sprite.ts noteStrip): frames keep the clip's shape since 2026-11-19; none noted = an old 160 × 90 strip
  `ALTER TABLE derivatives ADD COLUMN cell_w INTEGER; ALTER TABLE derivatives ADD COLUMN cell_h INTEGER;`,
  // Blur faces: a version that is a blurred render names its original by full SHA-256 (the key a blurred master and its
  // original link on, upload-gate.ts mayLeave); an upload declares it at its start
  `ALTER TABLE asset_versions ADD COLUMN blurred_of TEXT;
  ALTER TABLE uploads ADD COLUMN blurred_of TEXT;`,
  // a file by its size and fingerprint (report.ts: a scan's match, a file moved into a left-out folder)
  `CREATE INDEX IF NOT EXISTS versions_quick ON asset_versions(quick);`,
  // Folders left out (report.ts): a clip whose only known place is in a left-out folder, while it waits to be trashed or
  // kept, is hidden from every view, search, AI, player and share link (a privacy list, owner 2026-11-20). Not the trash
  `ALTER TABLE assets ADD COLUMN left_hidden_at INTEGER;`,
  // the computer a hidden clip waits on (report.ts adoptLeft): after a restart only that computer takes up its wait
  `ALTER TABLE assets ADD COLUMN left_hidden_on TEXT;`,
  // when each running listing started (report.ts), kept through a restart: a listing that began before a clip was found
  // in a left-out folder never counts as read since, and its last page marks gone only what it did not name
  `CREATE TABLE listing_starts (key TEXT PRIMARY KEY, at INTEGER NOT NULL);`,
  // a clip hidden on a computer that went silent (report.ts settleSilent): trashed, with that computer's name for the
  // Library status line; and when each computer no longer paired was first missed (its silence starts then)
  `ALTER TABLE assets ADD COLUMN left_trashed_from TEXT;
  CREATE TABLE left_gone_computers (device TEXT PRIMARY KEY, since INTEGER NOT NULL);`,
  // the pages of each running listing that came (report.ts), so one with a page lost never counts as whole; and the
  // clips hidden while they wait, found fast (few)
  `ALTER TABLE listing_starts ADD COLUMN pages TEXT NOT NULL DEFAULT '[]';
  CREATE INDEX IF NOT EXISTS assets_left_hidden ON assets(left_hidden_at) WHERE left_hidden_at IS NOT NULL;`,
  // the server process a listing began in (report.ts): one of a computer that numbers no pages, begun before a restart,
  // marks nothing gone
  `ALTER TABLE listing_starts ADD COLUMN boot TEXT;`,
  // a file's blur answer, set once when it comes in (contracts Blur, owner 2026-11-20): 'yes' | 'no'; null (from before)
  // reads the library's Blur faces (db.ts BLUR_SQL). An upload carries the answer it was started with
  `ALTER TABLE assets ADD COLUMN blur TEXT;
  ALTER TABLE uploads ADD COLUMN blur TEXT;`,
  // what an AI Editor version's pictures were made of when its steps started (editor/preview.ts markStart), the server's
  // own record (a computer's result never writes it): a cut is filed blurred only when its start and its end say so
  `CREATE TABLE render_marks (edit_id TEXT NOT NULL, variant TEXT NOT NULL, mark TEXT NOT NULL, PRIMARY KEY (edit_id, variant));`,
  // "Make for new files" (made.ts): the background catch-ups fill only files added since each switch went on, so the
  // files already in a library get these only from "Make for the missing". Libraries from before start from now
  `UPDATE libraries SET settings = json_set(settings, '$.lookSince', CAST(strftime('%s', 'now') AS INTEGER) * 1000, '$.timelineSince', CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    '$.embedSince', CAST(strftime('%s', 'now') AS INTEGER) * 1000, '$.picturesSince', CAST(strftime('%s', 'now') AS INTEGER) * 1000);`,
  // the file's modified time on the computer it was uploaded or dropped from (File.lastModified): Date filmed's last
  // guess before the time it was added (shoots.ts FILE_DATE). An upload carries it from its start
  `ALTER TABLE asset_versions ADD COLUMN modified_at INTEGER;
  ALTER TABLE uploads ADD COLUMN modified_at INTEGER;`,
  // a folder kept as filmed (its menu's Blur faces off): every clip in it reads blur no (db.ts BLUR_SQL), clips filed later too
  `ALTER TABLE collections ADD COLUMN blur TEXT;
  CREATE INDEX IF NOT EXISTS collection_items_asset ON collection_items(asset_id);`,
  // a server probe read a video's filming date from creation_time, the time an edited or sent file was written (media/
  // probe.ts, fixed 11-23): every video is read again once, by its computer (report.ts) or where it is (organize.ts)
  `UPDATE asset_versions SET probe = json_remove(probe, '$.camera')
    WHERE json_type(probe, '$.camera') IS NOT NULL AND asset_id IN (SELECT id FROM assets WHERE kind = 'video');`,
  // a piece merged into another waits in the Finals trash with what Restore needs (collections.ts unmerge): { into,
  // items: [{ id, position, winner }] }. The trash purge removes it
  `ALTER TABLE pieces ADD COLUMN merged TEXT;`,
  // a job the library's Stop took off the queue is 'stopped' (made.ts stopQueued): neither failed nor missing, so no sweep
  // queues it again and Retry does. SQLite keeps a CHECK in the table, so jobs is rebuilt; Stop's old 'failed' rows move over
  `CREATE TABLE jobs_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id TEXT NOT NULL,
    version_id TEXT,
    kind TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','needs_key','stopped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    run_after INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    actor TEXT,
    error TEXT,
    started_at INTEGER,
    done_at INTEGER,
    held_by TEXT,
    claim_id TEXT,
    UNIQUE (version_id, kind)
  );
  INSERT INTO jobs_new (id, library_id, version_id, kind, state, attempts, run_after, lease_until, actor, error, started_at, done_at, held_by, claim_id)
    SELECT id, library_id, version_id, kind, CASE WHEN state = 'failed' AND error = 'Stopped' THEN 'stopped' ELSE state END, attempts, run_after, lease_until,
      actor, CASE WHEN state = 'failed' AND error = 'Stopped' THEN NULL ELSE error END, started_at, done_at, held_by, claim_id FROM jobs;
  -- the numbering carries on where it was, so a deleted job's id (one a computer may still report on) is never given again
  DELETE FROM sqlite_sequence WHERE name = 'jobs_new';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'jobs_new', seq FROM sqlite_sequence WHERE name = 'jobs';
  DROP TABLE jobs;
  ALTER TABLE jobs_new RENAME TO jobs;`,
  // a file's proxy answer from its add (the add sheet, owner 2026-11-24): 'yes' | 'no'; null follows the library's
  // Generate proxies (db.ts fileProxy). An upload carries the answer it was started with
  `ALTER TABLE assets ADD COLUMN proxy TEXT;
  ALTER TABLE uploads ADD COLUMN proxy TEXT;`,
  // why a file's blur answer is no (contracts BlurNote): 'none' Face Blur found no face to cover, 'skipped' it was in the
  // library when Blur faces went on and nobody asked for it; null a person kept it as filmed (every no from before this)
  `ALTER TABLE assets ADD COLUMN blur_note TEXT;`,
  // Blur faces, Upload → Blurred: stored as "proxies" until now, it is the Originals part from here on (db.ts libraryUploadStored:
  // the blurred copies themselves; Proxies is its own row). Generate proxies was never read under Blur faces, so it is
  // stored off there: nothing starts being made by this
  `UPDATE libraries SET settings = json_set(settings, '$.upload', 'originals')
     WHERE json_extract(settings, '$.blurFaces') = 1 AND json_extract(settings, '$.upload') IN ('proxies', 'all');
   UPDATE libraries SET settings = json_set(settings, '$.proxy', json('false')) WHERE json_extract(settings, '$.blurFaces') = 1;`,
  // Generate proxies starts off in a new library (db.ts SETTING_DEFAULTS). A library that never stored the switch read
  // on until now, so on is stored: nothing changes for it by itself. And every library that is on gets the time its
  // switch "went on" (proxySince, db.ts SINCE), now: its proxies go to files added from here, never to one probed again
  `UPDATE libraries SET settings = json_set(settings, '$.proxy', json('true')) WHERE json_extract(settings, '$.proxy') IS NULL;
   UPDATE libraries SET settings = json_set(settings, '$.proxySince', CAST(strftime('%s', 'now') AS INTEGER) * 1000) WHERE json_extract(settings, '$.proxy') = 1;`,  // a file to blur that came from a phone or a browser (held.ts): 1 while the server holds its bytes (library/held/<version
  // id>) for the main computer and its blur; null once it is blurred or decided, and on every other version
  `ALTER TABLE asset_versions ADD COLUMN held INTEGER;`,
  // the version an upload became once it is in the library (a file the library had already: that clip's current version),
  // written with its 'done': a chat's ask that waits on the upload reads it, after a restart too (assistant.ts addsNow)
  // and a chat reply that waited for its message's files has started (assistant.ts pumpOnce): the row is the claim, made
  // by the one server process that starts it
  `ALTER TABLE uploads ADD COLUMN version_id TEXT;
  CREATE TABLE chat_starts (reply TEXT PRIMARY KEY, at INTEGER NOT NULL);`,
  // Blur faces, putting right an earlier step here (the one that sets Upload to originals): it stored Blurred (until then "proxies") as the Originals part with
  // Generate proxies off, which changed by itself what such a library does. The proxies the server holds of clips kept
  // as filmed stopped being served (upload-gate.ts mayServe asks for the Proxies part), and each new blurred copy went up
  // whole where a proxy of it had. Back to how it behaved: the proxies go up (Upload → Proxies, Generate proxies on, for
  // files from now: proxySince) and Blurred, which nobody chose, is off. Only a library that step made matches:
  // Originals could not be stored under Blur faces before it
  `UPDATE libraries SET settings = json_set(settings, '$.upload', 'proxies', '$.proxy', json('true'), '$.proxySince', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
     WHERE json_extract(settings, '$.blurFaces') = 1 AND json_extract(settings, '$.upload') = 'originals' AND json_extract(settings, '$.proxy') = 0;`,
  // a computer's folder listing looks each file up by its path (report.ts applyFolder): without this every file read
  // every place row of its folder, so a page's time grew with the square of the library
  `CREATE INDEX IF NOT EXISTS version_places_path ON version_places(device, path);`,
  // the library's monthly budget is gone (budgets are per key now, my-keys.ts): what it held runs again, and its setting goes
  `UPDATE jobs SET error = NULL, run_after = 0 WHERE state = 'queued' AND error = 'monthly budget reached';
  UPDATE libraries SET settings = json_remove(settings, '$.lookBudget') WHERE json_type(settings, '$.lookBudget') IS NOT NULL;`,
];
