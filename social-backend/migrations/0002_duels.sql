-- Friend streaks, duels and nudges.

-- When the extension synced the solve live, in ms. Null for history that was
-- imported rather than solved live: an import happening mid-duel must never
-- count as a fresh solve, so only stamped rows take part in duels.
ALTER TABLE submissions ADD COLUMN solved_at INTEGER;

CREATE INDEX IF NOT EXISTS submissions_by_time ON submissions(user_id, solved_at);

-- When a request was accepted, so the requester can be told.
ALTER TABLE friendships ADD COLUMN accepted_at INTEGER;

-- A race is first to an Accepted on one problem; a sprint is most solves in
-- the window. Scores are written when the duel settles, and computed live
-- until then.
CREATE TABLE IF NOT EXISTS duels (
    id               INTEGER PRIMARY KEY,
    kind             TEXT    NOT NULL CHECK (kind IN ('race', 'sprint')),
    challenger_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status           TEXT    NOT NULL CHECK (status IN ('pending', 'active', 'finished', 'declined', 'cancelled')),
    problem_key      TEXT,
    problem_title    TEXT,
    problem_link     TEXT,
    duration_ms      INTEGER NOT NULL,
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    ends_at          INTEGER,
    -- When the server learned the result (drives notifications).
    finished_at      INTEGER,
    -- Race only: when the winning solve happened.
    decided_at       INTEGER,
    winner_id        INTEGER,
    challenger_score INTEGER,
    opponent_score   INTEGER,
    forfeited_by     INTEGER,
    CHECK (challenger_id <> opponent_id)
);

CREATE INDEX IF NOT EXISTS duels_by_challenger ON duels(challenger_id, status);
CREATE INDEX IF NOT EXISTS duels_by_opponent ON duels(opponent_id, status);

CREATE TABLE IF NOT EXISTS nudges (
    id          INTEGER PRIMARY KEY,
    from_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nudges_by_to ON nudges(to_id, created_at);
CREATE INDEX IF NOT EXISTS nudges_by_pair ON nudges(from_id, to_id, created_at);
