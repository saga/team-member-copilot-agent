import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

// 数据目录在进程启动时一次性建好，后面各 service 直接写，不用到处 mkdir。
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.memberHomeRoot, { recursive: true });
fs.mkdirSync(config.workspaceRoot, { recursive: true });
fs.mkdirSync(config.copilotBaseDirectory, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  tool_profile TEXT NOT NULL DEFAULT 'safe'
    CHECK (tool_profile IN ('safe', 'coding')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('direct', 'group', 'work')),
  default_member_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (default_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_type TEXT NOT NULL
    CHECK (sender_type IN ('user', 'member', 'system')),
  sender_id TEXT NOT NULL,
  target_member_id TEXT,
  reply_to_message_id TEXT,
  content TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_member_id)
    REFERENCES member(id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_message_conversation_created
  ON conversation_message(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS member_runtime (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  copilot_session_id TEXT NOT NULL UNIQUE,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'error')),
  last_used_at TEXT,
  UNIQUE (conversation_id, member_id),
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  runtime_id TEXT,
  parent_execution_id TEXT,
  delegation_path TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL
    CHECK (
      kind IN (
        'interactive',
        'member_delegate',
        'member_work'
      )
    ),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (
      status IN (
        'queued',
        'running',
        'completed',
        'failed',
        'cancelled'
      )
    ),
  prompt TEXT NOT NULL,
  response TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id)
    REFERENCES conversation(id)
    ON DELETE CASCADE,
  FOREIGN KEY (member_id)
    REFERENCES member(id),
  FOREIGN KEY (runtime_id)
    REFERENCES member_runtime(id),
  FOREIGN KEY (parent_execution_id)
    REFERENCES execution(id)
);

CREATE INDEX IF NOT EXISTS idx_execution_conversation_created
  ON execution(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_parent
  ON execution(parent_execution_id);
`);

export function now(): string {
  return new Date().toISOString();
}
