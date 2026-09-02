// SQLite 하나가 전체 저장소다. Node 22 의 내장 node:sqlite 를 사용한다 (--experimental-sqlite 플래그 필요).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });

export const db = new DatabaseSync(fileURLToPath(new URL('../data/cowork.db', import.meta.url)));

// 스키마 근거: docs/2026-09-02-cowork-db-schema.md (확정안).
// 초안 스키마로 만들어진 기존 DB 는 개발 데이터뿐이라 ALTER 대신 재생성한다: server/data/cowork.db 를 지우고 seed-admin 을 다시 실행.
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    login_id   TEXT UNIQUE NOT NULL,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subpages (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    pos        REAL NOT NULL,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'text',
    ref        TEXT,
    text       TEXT NOT NULL,
    pos        REAL NOT NULL,
    style      TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

-- notices 는 아직 확정 전 초안 스키마다
CREATE TABLE IF NOT EXISTS notices (
    id         TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    author_id  TEXT REFERENCES users(id),
    ts         INTEGER NOT NULL
);
`);
