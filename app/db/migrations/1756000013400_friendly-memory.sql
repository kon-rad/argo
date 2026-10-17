-- Up Migration

-- Friendly (a Reachy Mini companion robot) long-term memory. This database is the
-- master; the robot's host keeps a local SQLite copy and replays its writes here.
-- Tables live in public as friendly_* so they inherit the default grants
-- (sb_app read/write, sb_agent and sb_read read). Biometrics and consent never
-- leave these tables; nothing here is copied into a third-party memory engine.

CREATE TABLE friendly_people (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL,
  aliases      text[] NOT NULL DEFAULT '{}',
  is_owner     boolean NOT NULL DEFAULT false,
  consent_at   timestamptz,
  consent_how  text,
  how_to_talk  text NOT NULL DEFAULT '',
  profile      text NOT NULL DEFAULT '',
  notes_path   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX friendly_people_name ON friendly_people (lower(name));

CREATE TABLE friendly_biometrics (
  id           bigserial PRIMARY KEY,
  person_id    bigint NOT NULL REFERENCES friendly_people(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('face', 'voice')),
  embedding    vector NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE friendly_episodes (
  id           bigserial PRIMARY KEY,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  body         text,
  persona      text,
  role         text,
  present      bigint[] NOT NULL DEFAULT '{}'
);

CREATE TABLE friendly_utterances (
  id              bigserial PRIMARY KEY,
  episode_id      bigint REFERENCES friendly_episodes(id) ON DELETE CASCADE,
  speaker_person  bigint REFERENCES friendly_people(id) ON DELETE SET NULL,
  speaker_persona text,
  text            text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  cut_off         boolean NOT NULL DEFAULT false,
  mode            text,
  tools           jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX friendly_utterances_episode ON friendly_utterances (episode_id, at);

CREATE TABLE friendly_facts (
  id               bigserial PRIMARY KEY,
  subject_person   bigint REFERENCES friendly_people(id) ON DELETE CASCADE,
  subject_self     boolean NOT NULL DEFAULT false,
  text             text NOT NULL,
  importance       smallint NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  superseded_by    bigint REFERENCES friendly_facts(id),
  source_utterance bigint REFERENCES friendly_utterances(id) ON DELETE SET NULL,
  embedding        vector(1024),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_person IS NOT NULL) <> subject_self)
);
CREATE INDEX friendly_facts_current ON friendly_facts (subject_person) WHERE valid_to IS NULL;

CREATE TABLE friendly_reflections (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  text   text NOT NULL,
  cites  bigint[] NOT NULL DEFAULT '{}'
);

CREATE TABLE friendly_sessions (
  persona     text NOT NULL,
  harness     text NOT NULL,
  session_id  text NOT NULL,
  body        text,
  last_used   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (persona, harness)
);

CREATE TABLE friendly_jobs (
  id            bigserial PRIMARY KEY,
  task_id       text,
  requested_by  bigint REFERENCES friendly_people(id) ON DELETE SET NULL,
  request       text NOT NULL,
  state         text NOT NULL DEFAULT 'created',
  result        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- forget(person) is a delete on friendly_people (the cascade does the rest).
-- sb_app's default grant has no DELETE.
GRANT DELETE ON friendly_people TO sb_app;

-- No seed row: the robot's host creates its owner through its own sync.

-- Down Migration
DROP TABLE friendly_jobs, friendly_sessions, friendly_reflections, friendly_facts,
           friendly_utterances, friendly_episodes, friendly_biometrics, friendly_people;
