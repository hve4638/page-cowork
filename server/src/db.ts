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
    parent_id  TEXT,                   -- NULL = 페이지 최상위. 중첩 조립품은 MVP 이후지만 컬럼은 확정안대로 미리 둔다
    type       TEXT NOT NULL DEFAULT 'text',
    ref        TEXT,
    text       TEXT NOT NULL,
    pos        REAL NOT NULL,
    style      TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
);

-- 파일 메타. 실체는 server/data/files/<id> (확장자 없음, gitignore). 삭제·GC 는 MVP 범위 밖이라 블럭을 지워도 실체는 남는다.
CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    author_id  TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL
);

-- 회의 녹음. 링크 블럭(type='recording')이 ref 로 가리킨다. 경과 시간 = duration_ms + (now - segment_started_at) (녹음 중일 때).
-- 청크 실체는 녹음 중 server/data/recordings/<id> 에 이어 붙이고, 종료 시 files 로 옮겨 file_id 에 연결한다.
-- last_chunk_at 은 녹음자 브라우저가 살아 있다는 마지막 신호로, 10분 이상 갱신이 없으면 서버가 자동 종료한다.
CREATE TABLE IF NOT EXISTS recordings (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'recording', -- recording | paused | stopped
    started_by         TEXT REFERENCES users(id),
    started_at         INTEGER NOT NULL,
    duration_ms        INTEGER NOT NULL DEFAULT 0,        -- 확정된 누적 녹음 시간 (현재 구간 제외)
    segment_started_at INTEGER,                           -- 현재 구간 시작 시각. 일시정지·종료면 NULL
    file_id            TEXT REFERENCES files(id),         -- 종료 후 완성 파일
    last_chunk_at      INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);

-- 녹음의 특정 시각에 남기는 메모. 보는 사람 누구나 남길 수 있다. offset_ms 는 녹음 경과 시각.
CREATE TABLE IF NOT EXISTS recording_marks (
    id           TEXT PRIMARY KEY,
    recording_id TEXT NOT NULL REFERENCES recordings(id),
    offset_ms    INTEGER NOT NULL,
    text         TEXT NOT NULL,
    author_id    TEXT REFERENCES users(id),
    created_at   INTEGER NOT NULL
);
`);
