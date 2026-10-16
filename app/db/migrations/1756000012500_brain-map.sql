-- Up Migration

-- Brain map: the 3D /map page (map module).
--
-- metric_samples is a record (one row per reading, written only by
-- cli-metrics). map_* are derived: `secondbrain map-build` rebuilds them from
-- vault_files, vault_links, the tracker and goals-master.md, and nothing else
-- writes them.

CREATE TABLE metric_samples (
  id          bigserial PRIMARY KEY,
  metric      text NOT NULL,                 -- 'x.example.followers'
  source      text NOT NULL,                 -- 'fxtwitter', 'youtube-page', 'manual'
  value       numeric NOT NULL,
  unit        text NOT NULL,                 -- 'followers', 'usd', 'hours'
  currency    text,                          -- 'USD' for money, NULL otherwise
  sampled_at  timestamptz NOT NULL DEFAULT now(),
  raw         jsonb
);
CREATE INDEX metric_samples_metric_idx ON metric_samples (metric, sampled_at DESC);

CREATE TABLE map_layouts (
  version     integer PRIMARY KEY,
  built_at    timestamptz NOT NULL DEFAULT now(),
  nodes       integer NOT NULL,
  edges       integer NOT NULL,
  ms          integer NOT NULL
);

CREATE TABLE map_nodes (
  version     integer NOT NULL REFERENCES map_layouts(version) ON DELETE CASCADE,
  id          text NOT NULL,                 -- 'mission', 'goal:Y2', 'division:argo-media', 'project:x', 'feature:12', 'note:345', 'metric:y2.followers'
  kind        text NOT NULL CHECK (kind IN ('mission','goal','division','project','feature','note','metric')),
  label       text NOT NULL,
  ref         text,                          -- vault path, project slug, feature id or metric key
  parent      text,                          -- the anchor this node hangs off
  color_key   text,                          -- division slug, feature stage, or top-level folder
  size        real NOT NULL DEFAULT 1,
  x           real NOT NULL,
  y           real NOT NULL,
  z           real NOT NULL,
  meta        jsonb,
  PRIMARY KEY (version, id)
);

CREATE TABLE map_edges (
  version     integer NOT NULL REFERENCES map_layouts(version) ON DELETE CASCADE,
  source      text NOT NULL,
  target      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('link','belongs','goal')),
  PRIMARY KEY (version, source, target, kind)
);

-- Down Migration

DROP TABLE map_edges;
DROP TABLE map_nodes;
DROP TABLE map_layouts;
DROP TABLE metric_samples;
