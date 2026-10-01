-- The weekly league: a crown for each Monday–Sunday week in which you solved
-- the most among yourself and the friends you had when it was settled.
--
-- Crowns are settled lazily, the first time someone reads their friends
-- after a week has closed; league_settled_week is the Monday ("YYYY-MM-DD")
-- of the first week not yet settled for them.

CREATE TABLE IF NOT EXISTS crowns (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    week_start  TEXT    NOT NULL,
    solves      INTEGER NOT NULL,
    PRIMARY KEY (user_id, week_start)
);

ALTER TABLE users ADD COLUMN league_settled_week TEXT;
