-- Forward-only approval metadata for existing skills installations.
-- Approval metadata only. Policy YAML remains in Git. An owner receipt binds the last policy-changing
-- revision and exact bytes, so unrelated later note commits do not require reapproval.
CREATE TABLE skill_policy_approvals (
  id bigserial PRIMARY KEY,
  repo text NOT NULL CHECK (repo ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' AND length(repo)<=200),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 1024 AND path !~ '(^/|(^|/)\.\.(/|$))'),
  revision text NOT NULL CHECK (revision ~ '^[0-9a-f]{40,64}$'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 200),
  approved_by text NOT NULL CHECK (length(btrim(approved_by)) BETWEEN 1 AND 100),
  approved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skill_policy_approvals_latest ON skill_policy_approvals (repo,path,approved_at DESC,id DESC);
REVOKE ALL ON skill_policy_approvals FROM PUBLIC;
REVOKE ALL ON SEQUENCE skill_policy_approvals_id_seq FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_agent') THEN
    REVOKE ALL ON skill_policy_approvals FROM sb_agent;
    REVOKE ALL ON SEQUENCE skill_policy_approvals_id_seq FROM sb_agent;
    GRANT SELECT ON skill_policy_approvals TO sb_agent;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_app') THEN
    GRANT SELECT, INSERT ON skill_policy_approvals TO sb_app;
    GRANT USAGE ON SEQUENCE skill_policy_approvals_id_seq TO sb_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sb_org') THEN
    REVOKE ALL ON skill_policy_approvals FROM sb_org;
    REVOKE ALL ON SEQUENCE skill_policy_approvals_id_seq FROM sb_org;
    GRANT SELECT ON skill_policy_approvals TO sb_org;
  END IF;
END $$;
