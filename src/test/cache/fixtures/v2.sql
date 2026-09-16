-- Version 2: version 1 plus the imodels and changesets tables, and the schema_version stamp.
CREATE TABLE IF NOT EXISTS briefcase_ids (
  imodel_id TEXT NOT NULL,
  briefcase_id INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, briefcase_id)
);

CREATE TABLE IF NOT EXISTS downloaded_briefcases (
  imodel_id TEXT NOT NULL,
  briefcase_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  changeset_id TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, briefcase_id)
);

CREATE TABLE IF NOT EXISTS downloaded_checkpoints (
  imodel_id TEXT NOT NULL,
  changeset_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (imodel_id, changeset_id)
);

CREATE TABLE IF NOT EXISTS downloaded_manifests (
  imodel_id TEXT NOT NULL PRIMARY KEY,
  file_path TEXT NOT NULL,
  etag TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS imodels (
  imodel_id TEXT NOT NULL PRIMARY KEY,
  itwin_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT
);

CREATE INDEX IF NOT EXISTS ix_imodels_itwin ON imodels (itwin_id);

CREATE TABLE IF NOT EXISTS changesets (
  imodel_id TEXT NOT NULL,
  changeset_index INTEGER NOT NULL,
  changeset_id TEXT NOT NULL,
  parent_id TEXT,
  description TEXT,
  push_date_time TEXT,
  briefcase_id INTEGER,
  file_size INTEGER NOT NULL,
  containing_changes INTEGER,
  state TEXT,
  group_id TEXT,
  creator_id TEXT,
  file_path TEXT,
  downloaded_at TEXT,
  PRIMARY KEY (imodel_id, changeset_index)
);

CREATE INDEX IF NOT EXISTS ix_changesets_id ON changesets (imodel_id, changeset_id);

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version (version) VALUES (2);
