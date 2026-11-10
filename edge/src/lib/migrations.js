// Database schema, owned by the edge script.
//
// On the first request of each cold start, migrate() reads schema_version and
// applies every pending migration in order. Each migration runs in a single
// transaction (one batch), so it is applied completely or not at all.
// Never edit a migration that has shipped; add a new one at the end instead.

export const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      `CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        role_title TEXT NOT NULL DEFAULT '',
        avatar_url TEXT,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        last_login_at TEXT
      )`,
      `CREATE INDEX users_created_by ON users(created_by)`,

      `CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX sessions_user ON sessions(user_id)`,

      `CREATE TABLE login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL COLLATE NOCASE,
        attempted_at TEXT NOT NULL,
        succeeded INTEGER NOT NULL
      )`,
      `CREATE INDEX login_attempts_email ON login_attempts(email, attempted_at)`,

      // is_system marks the automatic "Everyone" department: every active
      // member belongs to it implicitly, and it cannot be renamed or deleted.
      `CREATE TABLE departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        position INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE department_members (
        department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        is_leader INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        PRIMARY KEY (department_id, user_id)
      )`,
      `CREATE INDEX department_members_user ON department_members(user_id)`,
      `CREATE INDEX department_members_added_by ON department_members(added_by)`,

      `CREATE TABLE spaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )`,

      `CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX categories_space ON categories(space_id)`,

      `CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        is_published INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        last_major_revision_at TEXT,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      )`,
      `CREATE INDEX documents_category ON documents(category_id)`,
      `CREATE INDEX documents_created_by ON documents(created_by)`,
      `CREATE INDEX documents_updated_by ON documents(updated_by)`,

      `CREATE TABLE steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        content_json TEXT,
        content_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX steps_document ON steps(document_id)`,

      `CREATE TABLE grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL CHECK (target_type IN ('category', 'document')),
        target_id INTEGER NOT NULL,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('department', 'user')),
        principal_id INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('none', 'view', 'edit_review', 'edit_publish')),
        mandatory INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        UNIQUE (target_type, target_id, principal_type, principal_id),
        CHECK (level <> 'none' OR target_type = 'document')
      )`,
      `CREATE INDEX grants_principal ON grants(principal_type, principal_id)`,
      `CREATE INDEX grants_created_by ON grants(created_by)`,

      // Grants point at several tables, so foreign keys cannot clean them up.
      // These triggers do it instead (they also fire on cascading deletes).
      `CREATE TRIGGER grants_cleanup_category AFTER DELETE ON categories BEGIN
        DELETE FROM grants WHERE target_type = 'category' AND target_id = OLD.id;
      END`,
      `CREATE TRIGGER grants_cleanup_document AFTER DELETE ON documents BEGIN
        DELETE FROM grants WHERE target_type = 'document' AND target_id = OLD.id;
      END`,
      `CREATE TRIGGER grants_cleanup_department AFTER DELETE ON departments BEGIN
        DELETE FROM grants WHERE principal_type = 'department' AND principal_id = OLD.id;
      END`,
      `CREATE TRIGGER grants_cleanup_user AFTER DELETE ON users BEGIN
        DELETE FROM grants WHERE principal_type = 'user' AND principal_id = OLD.id;
      END`,

      `CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'submitted', 'rejected')),
        revision_type TEXT CHECK (revision_type IN ('minor', 'major')),
        submit_note TEXT NOT NULL DEFAULT '',
        author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        submitted_at TEXT,
        reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TEXT,
        review_comment TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX drafts_author ON drafts(author_id)`,
      `CREATE INDEX drafts_reviewer ON drafts(reviewer_id)`,

      `CREATE TABLE step_views (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
        first_viewed_at TEXT NOT NULL,
        last_viewed_at TEXT NOT NULL,
        view_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, step_id)
      )`,
      `CREATE INDEX step_views_step ON step_views(step_id)`,

      `CREATE TABLE step_completions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
        completed_at TEXT NOT NULL,
        PRIMARY KEY (user_id, step_id)
      )`,
      `CREATE INDEX step_completions_step ON step_completions(step_id)`,

      `CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        read_at TEXT
      )`,
      `CREATE INDEX notifications_user ON notifications(user_id, read_at)`,

      `CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_path TEXT NOT NULL,
        public_url TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        uploaded_at TEXT NOT NULL
      )`,
      `CREATE INDEX files_uploaded_by ON files(uploaded_by)`,

      `CREATE VIRTUAL TABLE steps_fts USING fts5(
        step_id UNINDEXED,
        document_id UNINDEXED,
        doc_title,
        step_title,
        body,
        tokenize = 'porter unicode61 remove_diacritics 2'
      )`,

      `INSERT INTO departments (name, position, is_system, created_at) VALUES
        ('Everyone', 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('Management', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('Product', 2, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('Marketing', 3, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ('Admin', 4, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

async function currentVersion(db) {
  return Number((await db.value("SELECT MAX(version) FROM schema_version")) || 0);
}

export async function migrate(db) {
  await db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  let version = await currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    const statements = migration.statements.map((sql) => [sql, []]);
    statements.push(["INSERT INTO schema_version (version) VALUES (?)", [migration.version]]);
    try {
      await db.batch(statements, { foreignKeys: migration.foreignKeys !== false });
    } catch (error) {
      // Two cold starts can race. If the other one applied it, carry on.
      if ((await currentVersion(db)) >= migration.version) {
        version = migration.version;
        continue;
      }
      throw error;
    }
    version = migration.version;
  }
  return version;
}
