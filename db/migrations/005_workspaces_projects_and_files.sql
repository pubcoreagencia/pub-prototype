-- db/migrations/005_workspaces_projects_and_files.sql
-- PP 2.0: Workspaces, Projects, Multi-Tenancy, and Checkpoint Files

-- 1. Users (Platform Database)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Workspace Members (Multi-Tenant RBAC)
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS workspace_members_workspace_idx ON workspace_members(workspace_id);

-- 4. Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','BUILDING')),
  github_repository TEXT,
  github_branch TEXT,
  supabase_project_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id, updated_at DESC);

-- 5. Foreign Key from prototype_sessions to projects
ALTER TABLE prototype_sessions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS prototype_sessions_project_id_idx ON prototype_sessions(project_id);

-- 6. Checkpoint Files (Immutable Storage for Native Preview & Code Inspector)
CREATE TABLE IF NOT EXISTS prototype_checkpoint_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(checkpoint_id, path)
);

CREATE INDEX IF NOT EXISTS prototype_checkpoint_files_session_idx ON prototype_checkpoint_files(session_id);
CREATE INDEX IF NOT EXISTS prototype_checkpoint_files_cp_idx ON prototype_checkpoint_files(checkpoint_id);

-- 7. Data Migration for existing 104 sessions
DO $$
DECLARE
  v_default_user_id UUID := '00000000-0000-0000-0000-000000000000';
  v_default_workspace_id UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
  -- Ensure default platform user
  INSERT INTO users (id, email, name)
  VALUES (v_default_user_id, 'default@pubprototype.internal', 'Default User')
  ON CONFLICT (id) DO NOTHING;

  -- Ensure default workspace
  INSERT INTO workspaces (id, name, slug, owner_id)
  VALUES (v_default_workspace_id, 'Default Workspace', 'default-workspace', v_default_user_id)
  ON CONFLICT (id) DO NOTHING;

  -- Ensure default owner membership
  INSERT INTO workspace_members (workspace_id, user_id, role)
  VALUES (v_default_workspace_id, v_default_user_id, 'OWNER')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  -- Migrate distinct projects from existing sessions
  INSERT INTO projects (id, workspace_id, name, github_repository, github_branch)
  SELECT 
    gen_random_uuid(),
    v_default_workspace_id,
    s.project,
    MAX(s.repository),
    MAX(s.branch)
  FROM prototype_sessions s
  WHERE s.project_id IS NULL AND s.project IS NOT NULL
  GROUP BY s.project
  ON CONFLICT DO NOTHING;

  -- Link sessions to their created project
  UPDATE prototype_sessions s
  SET project_id = p.id
  FROM projects p
  WHERE s.project_id IS NULL AND s.project = p.name AND p.workspace_id = v_default_workspace_id;
END $$;
