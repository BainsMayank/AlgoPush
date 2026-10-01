-- AlgoPush profiles and friends.
--
-- An account is a GitHub identity (github_id is GitHub's immutable numeric id,
-- not the login, which can be renamed) plus the handle friends find you by.
-- Nothing here is a credential: sessions are stored as SHA-256 hashes, and the
-- GitHub token used to prove identity at sign-in is never written down.

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    github_id     INTEGER NOT NULL UNIQUE,
    github_login  TEXT    NOT NULL,
    handle        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT    NOT NULL,
    avatar_url    TEXT,
    -- 0 means friends see the profile but no solves, and none are stored.
    sharing       INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash    TEXT    PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);

-- One row per pair, in the direction the request was sent. 'accepted' rows are
-- friendships and are read in both directions.
CREATE TABLE IF NOT EXISTS friendships (
    requester_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status        TEXT    NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (requester_id, addressee_id),
    CHECK (requester_id <> addressee_id)
);

CREATE INDEX IF NOT EXISTS friendships_by_addressee ON friendships(addressee_id);

-- A mirror of the extension's syncedProblemsIndex, keyed the same way
-- ("<Platform>:<slug>"), so re-uploading it is idempotent.
CREATE TABLE IF NOT EXISTS submissions (
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key           TEXT    NOT NULL,
    platform      TEXT    NOT NULL,
    title         TEXT    NOT NULL,
    difficulty    TEXT,
    link          TEXT,
    solution_url  TEXT,
    solved_on     TEXT    NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS submissions_by_day ON submissions(user_id, solved_on);
