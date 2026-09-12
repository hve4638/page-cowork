// SQLite 하나가 전체 저장소다. Node 22 의 내장 node:sqlite 를 사용한다 (--experimental-sqlite 플래그 필요).
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, DB_PATH } from './config.ts';

mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 스키마 근거: docs/2026-09-02-cowork-db-schema.md (확정안).
// 초안 스키마로 만들어진 기존 DB 는 개발 데이터뿐이라 ALTER 대신 재생성한다: server/data/cowork.db 를 지우고 다시 기동.
db.exec(`
PRAGMA journal_mode = WAL;

-- 로그인은 이메일로 한다 (2026-09-12 auth-email-login, 아이디 컬럼 제거). name 은 닉네임(탭 이름표·탑바)이고 중복 불허·필수다. 본인이 탑바에서 고친다.
-- 관리자 여부는 컬럼이 아니라 <dataDir>/admin.txt 소속 여부다 (2026-09-12 admin-list, role 컬럼 제거). auth.ts isAdmin
CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT UNIQUE NOT NULL,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
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
    updated_at INTEGER NOT NULL,
    kind       TEXT,                   -- NULL | 'meeting' | 'template' | 'milestone' | 'work' | 'ticket'. 회의록·템플릿·프로젝트 항목은 모두 서브페이지다 (새 테이블 없음). 페이지 목록은 이 행들을 거른다
    db_id      TEXT,                   -- 소속 DB (dbs.id). 회의록은 meeting DB 에, 마일스톤·작업·티켓은 project DB 에 속한다. 보드 블럭이 ref 로 같은 DB 를 가리켜 목록을 그린다 (2026-09-12 project-items, 이전 board_id)
    parent_id  TEXT                    -- 상위 항목 (subpages.id). 작업 → 마일스톤, 티켓 → 작업. 같은 db_id 여야 한다 (sync.ts 가 검증). 상위를 지우면 NULL 로 비운다
);

-- DB: 앱 안의 이름 있는 묶음 (데이터베이스 접속과 무관). 보드 블럭이 숨겨 두던 uuid 키를 이름·설명이 있는 행으로 승격한 것이다 (2026-09-12 project-items).
-- kind 가 meeting 이면 회의 보드(meetings 블럭)가, project 면 마일스톤·작업·티켓 보드 블럭이 고른다. 같은 DB 를 가리키는 블럭은 같은 항목을 보인다.
CREATE TABLE IF NOT EXISTS dbs (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,          -- meeting | project
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  TEXT REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- 페이지 속성 (본문과 별개의 key-value, 마크다운 frontmatter 격). 속성 하나가 행 하나라 서로 다른 속성의 동시 편집이 덮어쓰지 않는다.
-- type: text | number | select | date | daterange | people. value 는 type 별 JSON (select 는 {value, options}, daterange 는 {start, end}, people 은 users.id 배열).
-- 회의록의 일시·목적이 첫 사용처이고, 마일스톤·작업·티켓 항목의 상태·담당자·기한도 같은 방식이다 (2026-09-12 project-items). id 는 '<doc_id>:<key>'.
CREATE TABLE IF NOT EXISTS page_props (
    id         TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL,
    key        TEXT NOT NULL,
    type       TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT 'null',
    pos        REAL NOT NULL,
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

-- 파일 메타. 실체는 server/data/files/<id> (확장자 없음, gitignore). 포인터가 없고 changes 로그에서도 30일간 안 보이면 GC 가 지운다 (sync.ts orphanFiles).
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

-- 사용자 정의 매크로 ('/' 명령). 단계(steps)는 순차 실행하는 명령 목록의 JSON 이고, inputs 는 실행 전에 묻는 변수 이름 목록이다.
-- 내장 명령·내장 매크로는 코드에 있고 여기엔 사용자가 만든 것만 산다 (2026-09-07 macro-template).
CREATE TABLE IF NOT EXISTS macros (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '',
    keywords   TEXT NOT NULL DEFAULT '[]',
    inputs     TEXT NOT NULL DEFAULT '[]',
    steps      TEXT NOT NULL DEFAULT '[]',
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 모든 변경의 append-only 로그 (2026-09-08 undo-model). 다른 테이블은 현재 상태이고 이 테이블이 그 이력이다. 지우지 않는다.
-- group_id 는 사용자 조작 하나(클라이언트가 만든 id)로, 되감기(undo)의 단위다. before·after 는 행 JSON (update 는 바뀐 컬럼만).
-- 설계: docs/2026-09-02-cowork-db-schema.md 의 changes 절.
CREATE TABLE IF NOT EXISTS changes (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    user_id  TEXT,
    group_id TEXT NOT NULL,
    tbl      TEXT NOT NULL,
    row_id   TEXT NOT NULL,
    action   TEXT NOT NULL,
    before   TEXT,
    after    TEXT,
    reverts  TEXT                     -- 되감기 묶음이면 되감은 원래 묶음의 group_id
);
CREATE INDEX IF NOT EXISTS changes_group ON changes(group_id);

-- 버전(스냅샷): changes 로그의 한 지점을 이름 붙여 둔 것 (2026-09-09 version-snapshot). 실제 이미지는 저장하지 않는다.
-- change_id 는 그 시점의 마지막 changes.id 이고, 되돌아가기는 그 이후 줄을 모두 역순으로 되감아 새 묶음 하나로 로그한다 (git revert 방식).
-- auto=1 은 서버가 자정 기준으로 만든 자동 버전. 버전 행 자체는 changes 에 로그하지 않는다 (되돌려도 버전 목록은 그대로다).
CREATE TABLE IF NOT EXISTS versions (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    change_id  INTEGER NOT NULL,
    auto       INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id)
);
`);

// 2026-09-07 meeting-page 에서 추가한 컬럼. 그 전에 만들어진 DB 에는 없으므로 기동 시 채워 넣는다 (재생성 없이 이어 쓰기 위해).
// 2026-09-12 project-items: board_id 를 db_id 로 이름을 바꾸고(값은 그대로 dbs.id 가 된다) parent_id 를 더한다.
const subpageCols = (db.prepare('PRAGMA table_info(subpages)').all() as { name: string }[]).map(c => c.name);
if (subpageCols.includes('board_id') && !subpageCols.includes('db_id')) {
    db.exec('ALTER TABLE subpages RENAME COLUMN board_id TO db_id');
    subpageCols[subpageCols.indexOf('board_id')] = 'db_id';
    console.log('[migrate] subpages: board_id → db_id');
}
for (const [col, type] of [['kind', 'TEXT'], ['db_id', 'TEXT'], ['parent_id', 'TEXT']]) {
    if (!subpageCols.includes(col)) db.exec(`ALTER TABLE subpages ADD COLUMN ${col} ${type}`);
}
// 2026-09-07 의 회의록 tombstone(deleted_at)은 2026-09-08 undo-model 에서 changes 로그로 흡수했다. 표시 삭제 상태였던 행은 본문·속성과 함께 실제로 지우고 컬럼을 없앤다.
if (subpageCols.includes('deleted_at')) {
    db.exec(`
        DELETE FROM blocks WHERE doc_id IN (SELECT id FROM subpages WHERE deleted_at IS NOT NULL);
        DELETE FROM page_props WHERE doc_id IN (SELECT id FROM subpages WHERE deleted_at IS NOT NULL);
        DELETE FROM subpages WHERE deleted_at IS NOT NULL;
        ALTER TABLE subpages DROP COLUMN deleted_at;
    `);
}

// 사이드바 "최근 편집"(recent_edits)은 2026-09-08 undo-model 에서 변경사항 목록으로 대체되어 테이블을 없앤다
db.exec('DROP TABLE IF EXISTS recent_edits');
const changeCols = (db.prepare('PRAGMA table_info(changes)').all() as { name: string }[]).map(c => c.name);
if (!changeCols.includes('reverts')) db.exec('ALTER TABLE changes ADD COLUMN reverts TEXT');

// 2026-09-12 auth-email-login: login_id(아이디)를 없애고 name(닉네임)을 UNIQUE NOT NULL 로 만든다. SQLite 는 ALTER 로 제약을 못 붙이므로 테이블을 다시 만든다.
// name 이 비어 있던 행은 login_id 를 닉네임으로 삼고, 그래도 겹치면 뒤에 번호를 붙인다. sessions 등의 FK 는 이름 'users' 를 가리키므로 새 테이블을 같은 이름으로 바꿔 끼우면 그대로 유효하다.
// node:sqlite 는 외래 키 검사를 기본으로 켜므로 (DROP 이 막힌다) 교체 동안만 끈다. PRAGMA foreign_keys 는 트랜잭션 밖에서만 먹는다.
const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name);
if (userCols.includes('login_id')) {
    const rows = db.prepare(`SELECT id, login_id, ${userCols.includes('name') ? 'name' : 'NULL AS name'} FROM users ORDER BY created_at, id`).all() as { id: string; login_id: string; name: string | null }[];
    const taken = new Set<string>();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    if (!userCols.includes('name')) db.exec('ALTER TABLE users ADD COLUMN name TEXT');
    const setName = db.prepare('UPDATE users SET name = ? WHERE id = ?');
    for (const r of rows) {
        const base = (r.name ?? '').trim() || r.login_id;
        let name = base;
        for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
        taken.add(name);
        setName.run(name, r.id);
    }
    db.exec(`
        CREATE TABLE users_new (
            id         TEXT PRIMARY KEY,
            email      TEXT UNIQUE NOT NULL,
            name       TEXT UNIQUE NOT NULL,
            pw_hash    TEXT NOT NULL,
            pw_salt    TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL
        );
        INSERT INTO users_new (id, email, name, pw_hash, pw_salt, status, created_at)
            SELECT id, email, name, pw_hash, pw_salt, status, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        COMMIT;
        PRAGMA foreign_keys = ON;
    `);
    console.log(`[migrate] users: login_id 제거, name 필수화 (${rows.length}명)`);
}

// 2026-09-12 admin-list: 관리자 여부를 users.role 이 아니라 admin.txt 로 판정하므로 컬럼을 떨어뜨린다.
// role='admin' 이던 계정은 admin.txt 에 이메일을 적어야 계속 관리자다 (기동 로그에 그 이메일을 남긴다).
if ((db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).some(c => c.name === 'role')) {
    const admins = (db.prepare("SELECT email FROM users WHERE role = 'admin'").all() as { email: string }[]).map(r => r.email);
    db.exec('ALTER TABLE users DROP COLUMN role');
    console.log(`[migrate] users: role 컬럼 제거. 관리자였던 이메일은 admin.txt 에 적어야 한다: ${admins.join(', ') || '(없음)'}`);
}

// 2026-09-12 project-items 이전의 회의 보드는 dbs 행 없이 uuid 키만 있었다. 보드 블럭의 ref 와 회의록의 db_id 에 남은 키마다 meeting DB 행을 만들어 그대로 이어 쓴다.
{
    const keys = new Set<string>();
    for (const r of db.prepare("SELECT ref FROM blocks WHERE type = 'meetings' AND ref IS NOT NULL").all() as { ref: string }[]) keys.add(r.ref);
    for (const r of db.prepare("SELECT db_id FROM subpages WHERE kind = 'meeting' AND db_id IS NOT NULL").all() as { db_id: string }[]) keys.add(r.db_id);
    const ins = db.prepare("INSERT OR IGNORE INTO dbs (id, kind, name, description, created_by, created_at, updated_at) VALUES (?, 'meeting', '회의', '', NULL, ?, ?)");
    let n = 0;
    for (const k of keys) if (ins.run(k, Date.now(), Date.now()).changes) n++;
    if (n) console.log(`[migrate] dbs: 기존 회의 보드 키 ${n}개를 meeting DB 로 등록`);
}

// 홈은 subpages 의 고정 행(id='home')이다. 제목만 여기 살고 본문 블럭은 다른 페이지처럼 blocks.doc_id='home' 이다.
// 링크 블럭 입구가 없어 연쇄 삭제에 걸리지 않고, 직접 delete 는 sync.ts 가 거부한다.
export const HOME_PAGE_ID = 'home';
db.prepare('INSERT OR IGNORE INTO subpages (id, title, pos, created_by, created_at, updated_at) VALUES (?, ?, 0, NULL, ?, ?)')
    .run(HOME_PAGE_ID, 'cowork', Date.now(), Date.now());

// 내장 템플릿. 템플릿은 kind='template' 인 서브페이지이고 본문·속성을 보통 페이지처럼 편집한다. 첫 기동 때 한 번 심고(INSERT OR IGNORE)
// 그 뒤로는 사용자가 고친 내용이 남는다 — "사용자가 고친 템플릿으로 새 회의가 만들어진다" 가 목표라 읽기 전용이 아니다.
// {{변수}} 는 매크로가 템플릿을 넣을 때 치환한다. 탭 이름이 목록 변수 하나({{팀원}})면 원소마다 탭이 하나씩 생긴다 (templates.ts).
export const MEETING_TEMPLATE_ID = 'tpl-meeting';
if (!db.prepare('SELECT 1 FROM subpages WHERE id = ?').get(MEETING_TEMPLATE_ID)) {
    const now = Date.now();
    db.prepare("INSERT INTO subpages (id, title, pos, created_by, created_at, updated_at, kind) VALUES (?, '회의록', 0, NULL, ?, ?, 'template')")
        .run(MEETING_TEMPLATE_ID, now, now);
    const prop = db.prepare('INSERT INTO page_props (id, doc_id, key, type, value, pos, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    prop.run(`${MEETING_TEMPLATE_ID}:일시`, MEETING_TEMPLATE_ID, '일시', 'date', 'null', 1, now);
    prop.run(`${MEETING_TEMPLATE_ID}:목적`, MEETING_TEMPLATE_ID, '목적', 'text', '"{{목적}}"', 2, now);
    const block = db.prepare('INSERT INTO blocks (id, doc_id, parent_id, type, ref, text, pos, style, updated_at) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?)');
    block.run('tpl-meeting-h', MEETING_TEMPLATE_ID, 'text', '## 안건\n\n## 논의\n\n## 결정 사항\n\n## 다음 할 일\n\n## 팀원별 자료', 1, '{}', now);
    block.run('tpl-meeting-t', MEETING_TEMPLATE_ID, 'tabs', '', 2, JSON.stringify({ tabs: [{ id: 'mbr0', label: '{{팀원}}' }] }), now);
}
