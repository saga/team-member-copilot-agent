import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { migrate } from './db-migrations.js';

// 数据目录在进程启动时一次性建好，后面各 service 直接写，不用到处 mkdir。
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.memberHomeRoot, { recursive: true });
fs.mkdirSync(config.workspaceRoot, { recursive: true });
fs.mkdirSync(config.copilotBaseDirectory, { recursive: true });

export const db = new DatabaseSync(config.dbPath);

// WAL：让 SSE 长连接读取和写入可以并发；foreign_keys 必须显式打开（SQLite 默认关闭）
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/**
 * schema 由 db-migrations.ts 管理：库的形状必须与 SCHEMA_SQL 完全一致，
 * 否则启动就失败。db.ts 只负责「打开 + 确保形状」，不内联 CREATE TABLE。
 */
export const migration = migrate(db);

export function now(): string {
  return new Date().toISOString();
}
