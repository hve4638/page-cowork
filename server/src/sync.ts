// 동기화 대상 테이블과 변경 적용. 모든 변경은 index.ts 의 WS 핸들러를 통해 직렬로 들어온다.
// 같은 행 충돌은 나중 것이 이기고(LWW), 없는 테이블·행 대상은 조용히 버린다 (빈 배열 반환). 예외는 blocks.text 로, base 가 오면 3-way 병합한다.
// 삭제는 연쇄될 수 있어 적용된 mutation 을 여러 개 돌려준다: 링크 블럭 → 서브페이지 → 그 문서의 블럭들, 부모 블럭 → 자식 블럭들(표의 칸).
// 모든 변경은 changes 테이블에 변경 전·후 이미지로 남고(append-only), 클라이언트가 붙인 묶음(group) 단위로 되감을 수 있다 (revert).
// 버전(versions)은 로그의 한 지점이고, 버전으로 되돌아가기는 그 이후 줄 전체를 되감은 묶음 하나다 (restoreVersion, 2026-09-09 version-snapshot).
// 설계 기록: docs/2026-09-02-cowork-db-schema.md 의 changes·versions 절 (2026-09-08 undo-model).
import DiffMatchPatch from 'diff-match-patch';
import { db, HOME_PAGE_ID } from './db.ts';

export type Mutation =
    | { action: 'insert'; table: string; row: Record<string, unknown> }
    | { action: 'update'; table: string; row: Record<string, unknown>; base?: string } // base: blocks.text 편집의 출발 텍스트 (3-way 병합용)
    | { action: 'delete'; table: string; id: string };

// WS 로 내보내는 테이블만 등재한다. users·sessions 는 동기화 대상이 아니다.
// readOnly 테이블(files·change_groups)은 스냅샷·브로드캐스트로 내려가기만 하고, 클라이언트의 mutation 은 버린다 — 행은 서버가 만든다.
const TABLES: Record<string, { cols: string[]; jsonCols: string[]; readOnly?: boolean }> = {
    blocks: { cols: ['id', 'doc_id', 'parent_id', 'type', 'ref', 'text', 'pos', 'style', 'updated_at'], jsonCols: ['style'] },
    subpages: { cols: ['id', 'title', 'pos', 'created_by', 'created_at', 'updated_at', 'kind', 'db_id', 'parent_id'], jsonCols: [] },
    // DB: 보드 블럭이 고르는 이름 있는 묶음 (2026-09-12 project-items). 삭제는 연쇄하지 않는다 (속한 페이지는 남고 보드가 "삭제된 DB" 로 보인다)
    dbs: { cols: ['id', 'kind', 'name', 'description', 'created_by', 'created_at', 'updated_at'], jsonCols: [] },
    page_props: { cols: ['id', 'doc_id', 'key', 'type', 'value', 'pos', 'updated_at'], jsonCols: ['value'] },
    files: { cols: ['id', 'name', 'mime', 'size', 'author_id', 'created_at'], jsonCols: [], readOnly: true },
    // change_groups 는 실제 테이블이 아니라 changes 로그의 묶음 요약 뷰다 (사이드바 변경사항 목록). 스냅샷에는 최근 GROUPS_IN_SNAPSHOT 개만 싣는다
    change_groups: { cols: ['id', 'user_id', 'user_name', 'ts', 'first_ts', 'inserts', 'updates', 'deletes', 'tables', 'doc_ids', 'reverts'], jsonCols: ['tables', 'doc_ids'], readOnly: true },
    // 녹음 상태(status·duration_ms·segment_started_at)는 녹음자 클라이언트가 WS 로 갱신하고, 종료·파일 연결은 HTTP(recordings.ts)가 한다.
    recordings: { cols: ['id', 'title', 'status', 'started_by', 'started_at', 'duration_ms', 'segment_started_at', 'file_id', 'last_chunk_at', 'transcribe', 'created_at', 'updated_at'], jsonCols: [] },
    recording_marks: { cols: ['id', 'recording_id', 'offset_ms', 'text', 'author_id', 'created_at'], jsonCols: [] },
    // AI 회의 노트: 전사·요약 결과와 그 진행 상태. 행을 만들고 고치는 것은 서버(ainotes.ts)뿐이라 읽기 전용이다 (2026-09-14 ai-meeting-notes)
    ai_notes: { cols: ['id', 'title', 'recording_id', 'file_id', 'status', 'stage', 'provider', 'language', 'duration_ms', 'model', 'summaries', 'error', 'created_by', 'created_at', 'updated_at'], jsonCols: ['summaries'], readOnly: true },
    // 전사 덩어리 하나가 행 하나다. 녹음 중에는 새 덩어리만 insert 되고 말이 이어지는 마지막 덩어리만 update 된다 (2026-09-14 실시간 전사)
    ai_note_segments: { cols: ['id', 'note_id', 'speaker', 'start_ms', 'end_ms', 'text'], jsonCols: [], readOnly: true },
    macros: { cols: ['id', 'name', 'icon', 'keywords', 'inputs', 'steps', 'created_by', 'created_at', 'updated_at'], jsonCols: ['keywords', 'inputs', 'steps'] },
    // 버전(스냅샷) 목록. 행은 서버가 만들고(WS 'version' 메시지·자정 자동), changes 에 로그하지 않는다 — 되돌려도 버전은 남는다
    versions: { cols: ['id', 'name', 'ts', 'change_id', 'auto', 'created_by'], jsonCols: [], readOnly: true },
};
// callout·toggle 은 텍스트를 담는 특수 블럭, table 은 자식 cell(parent_id = 표 id)을 거느리는 첫 중첩 조립품이다.
// 클라이언트가 WS 로 고칠 수 있는 recordings 컬럼. status 는 idle 에서 시작해 recording|paused 사이를 오간다 (stopped 는 HTTP 종료·파일 올리기가 찍는다).
// transcribe 는 'AI 전사' 토글이다. 켜져 있으면 녹음이 끝나는 순간 서버가 전사를 건다 (recordings.ts).
const RECORDING_CLIENT_COLS = ['title', 'status', 'duration_ms', 'segment_started_at', 'last_chunk_at', 'transcribe'];
// tabs 는 표처럼 자식(parent_id = 탭 블럭, style.tab = 슬롯)을 거느리는 조립품이고, 자식은 어떤 type 이든 될 수 있다(중첩 흐름).
// meetings 는 회의 보드: ref 가 DB(dbs.id, kind=meeting)이고 subpages.db_id 가 그 DB 를 참조한다. 보드 블럭을 지워도 DB·회의록은 남고, 같은 DB 를 고른 블럭이 다시 보인다.
// milestones·works·tickets 는 프로젝트 항목 보드: ref 가 project DB 이고 같은 DB 의 그 kind 페이지를 칸반으로 그린다 (2026-09-12 project-items). 삭제는 연쇄하지 않는다.
// button 은 매크로 버튼: text 가 이름표, ref 가 실행할 매크로 id(사용자 매크로 또는 'builtin:cmd:<명령>'). 누르면 그 아래에 결과가 들어간다 (macro-template).
const BLOCK_TYPES = ['text', 'subpage', 'image', 'file', 'callout', 'table', 'cell', 'recording', 'toggle', 'tabs', 'meetings', 'button', 'milestones', 'works', 'tickets'];
const PROP_TYPES = ['text', 'number', 'select', 'date', 'daterange', 'people'];
// 서브페이지 kind. 프로젝트 항목(milestone > work > ticket)은 parent_id 로 한 단계 위 kind 의 행을 가리키고, 같은 db_id 여야 한다.
const PAGE_KINDS = ['meeting', 'template', 'milestone', 'work', 'ticket'];
const PARENT_KIND: Record<string, string> = { work: 'milestone', ticket: 'work' };
const DB_KINDS = ['meeting', 'project'];
// parent_id 검증: 비어 있으면 통과. 있으면 상위 행이 있고 kind 가 한 단계 위이며 같은 DB 여야 한다. 되감기(revert)는 이 검증을 거치지 않는다.
function parentOk(kind: unknown, dbId: unknown, parentId: unknown): boolean {
    if (parentId === null || parentId === undefined) return true;
    const expect = PARENT_KIND[String(kind)];
    if (!expect || typeof parentId !== 'string') return false;
    const p = db.prepare('SELECT kind, db_id FROM subpages WHERE id = ?').get(parentId) as { kind: string | null; db_id: string | null } | undefined;
    return !!p && p.kind === expect && p.db_id === dbId;
}

type Row = Record<string, unknown>;

function decodeRow(def: { jsonCols: string[] }, row: Row): Row {
    for (const col of def.jsonCols) {
        try { row[col] = JSON.parse(String(row[col] ?? '{}')); } catch { row[col] = {}; }
    }
    return row;
}
// 디코드된 행을 DB 에 넣을 값으로. jsonCols 는 문자열로 되돌린다.
const encode = (def: { jsonCols: string[] }, col: string, v: unknown): string | number | null =>
    def.jsonCols.includes(col) ? JSON.stringify(v ?? null) : (v as string | number | null);

export function snapshot(): Record<string, unknown[]> {
    const tables: Record<string, unknown[]> = {};
    for (const [name, def] of Object.entries(TABLES)) {
        if (name === 'change_groups') continue;
        tables[name] = (db.prepare(`SELECT * FROM ${name}`).all() as Row[]).map(row => decodeRow(def, row));
    }
    tables.change_groups = recentGroups();
    return tables;
}

// ── 생명주기 훅 ────────────────────────────────────────
// 상태를 가진 행(녹음)이 삭제·복원될 때 다른 모듈이 반응하는 자리. recordings.ts 가 등록한다.
// beforeDelete 는 행을 지우기 직전(변경 전 이미지를 뜨기 전)에 불려서, 훅이 행을 고치면 그 결과가 로그에 남고 복원 때 그대로 돌아온다.
// 훅이 다른 행을 만들거나 고쳤으면 그 mutation 들을 돌려주어 함께 브로드캐스트한다 (로그 밖의 서버 자체 변경).
export type Hooks = { beforeDelete?: (row: Row) => Mutation[] | void; afterInsert?: (row: Row) => Mutation[] | void };
const hooks: Record<string, Hooks> = {};
export function registerHooks(table: string, h: Hooks): void { hooks[table] = h; }

// ── 변경 로그 ──────────────────────────────────────────
// 사용자 조작 하나(묶음)에 속한 행 단위 변경을 순서대로 남긴다. 되감기(revert)의 근거이고 지우지 않는다.
type Ctx = { userId: string | null; group: string; reverts?: string };
type ChangeRow = { id: number; user_id: string | null; group_id: string; tbl: string; row_id: string; action: string; before: string | null; after: string | null };
const lastChange = () => db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT 1').get() as ChangeRow | undefined;
const lastChangeId = () => (db.prepare('SELECT MAX(id) AS id FROM changes').get() as { id: number | null }).id ?? 0;
const sameKeys = (a: Row, b: Row) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i]); };
// 버전이 가리키는 마지막 줄은 그 뒤로 amend 하지 않는다 — 버전 이후의 타이핑이 버전 이전 줄에 섞여 들어가면 되돌아가도 남기 때문
let sealedId = 0;
function logChange(ctx: Ctx, tbl: string, rowId: string, action: 'insert' | 'update' | 'delete', before: Row | null, after: Row | null): void {
    const now = Date.now();
    // amend: 로그 맨 끝이 같은 사용자·묶음·행·컬럼의 update 면 새 줄 대신 after 만 갱신한다 (타이핑 스로틀이 덩어리당 한 줄로 남는다)
    if (action === 'update' && after) {
        const last = lastChange();
        if (last && last.id > sealedId && last.action === 'update' && last.user_id === ctx.userId && last.group_id === ctx.group && last.tbl === tbl && last.row_id === rowId
            && sameKeys(JSON.parse(last.after ?? '{}'), after)) {
            db.prepare('UPDATE changes SET ts = ?, after = ? WHERE id = ?').run(now, JSON.stringify(after), last.id);
            return;
        }
    }
    db.prepare('INSERT INTO changes (ts, user_id, group_id, tbl, row_id, action, before, after, reverts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, ctx.userId, ctx.group, tbl, rowId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ctx.reverts ?? null);
}

// ── 묶음 요약 (사이드바 변경사항 목록) ──────────────────
// 묶음 하나를 행 하나로: 누가·언제·어느 문서에서·무엇을 몇 건. 클라이언트는 change_groups 읽기 전용 테이블로 받는다.
const GROUPS_IN_SNAPSHOT = 50;
// 로그 줄이 건드린 문서. update 줄의 이미지에는 바뀐 컬럼만 있어 doc_id 가 없으므로 현재 행, 없으면 그 행의 insert·delete 줄에서 찾는다
function docOf(r: ChangeRow): string | null {
    const img = JSON.parse(r.after ?? r.before ?? '{}') as Row;
    if (typeof img.doc_id === 'string') return img.doc_id;
    const cur = db.prepare(`SELECT doc_id FROM ${r.tbl} WHERE id = ?`).get(r.row_id) as { doc_id: string } | undefined;
    if (cur) return cur.doc_id;
    const seen = db.prepare("SELECT before, after FROM changes WHERE tbl = ? AND row_id = ? AND action != 'update' ORDER BY id DESC LIMIT 1").get(r.tbl, r.row_id) as { before: string | null; after: string | null } | undefined;
    const full = seen && (JSON.parse(seen.after ?? seen.before ?? '{}') as Row);
    return full && typeof full.doc_id === 'string' ? full.doc_id : null;
}
export function groupSummary(group: string): Row | null {
    const rows = db.prepare('SELECT c.*, u.name AS user_name FROM changes c LEFT JOIN users u ON u.id = c.user_id WHERE c.group_id = ? ORDER BY c.id').all(group) as
        (ChangeRow & { ts: number; user_name: string | null; reverts: string | null })[];
    if (!rows.length) return null;
    const docs = new Set<string>(), tables = new Set<string>();
    let inserts = 0, updates = 0, deletes = 0;
    for (const r of rows) {
        tables.add(r.tbl);
        if (r.action === 'insert') inserts++; else if (r.action === 'update') updates++; else deletes++;
        const doc = r.tbl === 'subpages' ? r.row_id : r.tbl === 'blocks' || r.tbl === 'page_props' ? docOf(r) : null;
        if (typeof doc === 'string') docs.add(doc);
    }
    const first = rows[0], last = rows[rows.length - 1];
    return {
        id: group, user_id: first.user_id, user_name: first.user_name, ts: last.ts, first_ts: first.ts,
        inserts, updates, deletes, tables: [...tables], doc_ids: [...docs], reverts: first.reverts,
    };
}
export function recentGroups(limit = GROUPS_IN_SNAPSHOT): Row[] {
    const ids = db.prepare('SELECT group_id, MAX(id) AS last FROM changes GROUP BY group_id ORDER BY last DESC LIMIT ?').all(limit) as { group_id: string }[];
    return ids.map(g => groupSummary(g.group_id)!).filter(Boolean);
}

// 테이블별로 컬럼을 검증·보정해서 INSERT 할 완전한 행을 만든다. 형태가 맞지 않으면 null.
function prepareInsert(table: string, row: Row, userId: string): Row | null {
    if (typeof row.id !== 'string' || !row.id) return null;
    if (table === 'blocks') {
        if (typeof row.doc_id !== 'string' || typeof row.pos !== 'number') return null;
        return {
            id: row.id,
            doc_id: row.doc_id,
            parent_id: typeof row.parent_id === 'string' ? row.parent_id : null,
            type: BLOCK_TYPES.includes(row.type as string) ? (row.type as string) : 'text',
            ref: typeof row.ref === 'string' ? row.ref : null,
            text: typeof row.text === 'string' ? row.text : '',
            pos: row.pos,
            style: typeof row.style === 'object' && row.style ? row.style : {},
            updated_at: Date.now(),
        };
    }
    if (table === 'subpages') {
        const full: Row = {
            id: row.id,
            title: typeof row.title === 'string' ? row.title : '',
            pos: typeof row.pos === 'number' ? row.pos : Date.now(),
            created_by: userId,
            created_at: Date.now(),
            updated_at: Date.now(),
            kind: PAGE_KINDS.includes(row.kind as string) ? (row.kind as string) : null,
            db_id: typeof row.db_id === 'string' ? row.db_id : null,
            parent_id: typeof row.parent_id === 'string' ? row.parent_id : null,
        };
        if (!parentOk(full.kind, full.db_id, full.parent_id)) return null;
        return full;
    }
    if (table === 'dbs') {
        if (!DB_KINDS.includes(row.kind as string)) return null;
        return {
            id: row.id,
            kind: row.kind as string,
            name: typeof row.name === 'string' ? row.name : '',
            description: typeof row.description === 'string' ? row.description : '',
            created_by: userId,
            created_at: Date.now(),
            updated_at: Date.now(),
        };
    }
    if (table === 'page_props') {
        if (typeof row.doc_id !== 'string' || typeof row.key !== 'string' || !row.key || !PROP_TYPES.includes(row.type as string)) return null;
        return {
            id: row.id,
            doc_id: row.doc_id,
            key: row.key,
            type: row.type as string,
            value: row.value ?? null,
            pos: typeof row.pos === 'number' ? row.pos : Date.now(),
            updated_at: Date.now(),
        };
    }
    if (table === 'macros') {
        if (typeof row.name !== 'string') return null;
        return {
            id: row.id,
            name: row.name,
            icon: typeof row.icon === 'string' ? row.icon : '',
            keywords: Array.isArray(row.keywords) ? row.keywords : [],
            inputs: Array.isArray(row.inputs) ? row.inputs : [],
            steps: Array.isArray(row.steps) ? row.steps : [],
            created_by: userId,
            created_at: Date.now(),
            updated_at: Date.now(),
        };
    }
    if (table === 'recordings') {
        // 녹음 블럭을 꽂으면 먼저 idle 행이 생긴다. 사용자가 '녹음 시작' 을 누르거나 파일을 올려야 내용이 채워진다 (2026-09-14 ai-meeting-notes).
        return {
            id: row.id,
            title: typeof row.title === 'string' ? row.title : '',
            status: 'idle',
            started_by: userId,
            started_at: Date.now(),
            duration_ms: 0,
            segment_started_at: null,
            file_id: null,
            last_chunk_at: Date.now(),
            transcribe: row.transcribe ? 1 : 0,
            created_at: Date.now(),
            updated_at: Date.now(),
        };
    }
    if (table === 'recording_marks') {
        if (typeof row.recording_id !== 'string' || !exists('recordings', row.recording_id) || typeof row.offset_ms !== 'number') return null;
        return {
            id: row.id,
            recording_id: row.recording_id,
            offset_ms: Math.max(0, Math.round(row.offset_ms)),
            text: typeof row.text === 'string' ? row.text : '',
            author_id: userId,
            created_at: Date.now(),
        };
    }
    return null;
}

const exists = (table: string, id: unknown): boolean =>
    !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(String(id));
const readRow = (table: string, id: string): Row | undefined => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
    return row && decodeRow(TABLES[table], row);
};

// 디코드된 완전한 행을 넣고 로그·훅까지 처리한다. 새 insert 와 삭제 복원이 함께 쓴다.
function insertRow(ctx: Ctx, table: string, row: Row, out: Mutation[]): void {
    const def = TABLES[table];
    const cols = def.cols.filter(c => c in row);
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...cols.map(c => encode(def, c, row[c])));
    const full = readRow(table, String(row.id))!;
    logChange(ctx, table, String(row.id), 'insert', null, full);
    out.push({ action: 'insert', table, row: full });
    out.push(...(hooks[table]?.afterInsert?.(full) ?? []));
}

// 행 하나를 지우고 연쇄한다. 링크 블럭이 서브페이지·녹음의 유일한 입구라서 참조 행까지, 부모 블럭(표·탭)은 parent_id 로 매달린 자식까지 함께 지운다 (재귀).
// 자기 행을 먼저 지우므로 자기 자신을 가리키는 링크가 있어도 순환하지 않는다. 지운 행마다 로그 한 줄이고 모두 같은 묶음이다.
function deleteRow(ctx: Ctx, table: string, id: string, out: Mutation[]): void {
    if (table === 'subpages' && id === HOME_PAGE_ID) return; // 홈 행은 지울 수 없다
    const found = readRow(table, id);
    if (!found) return;
    out.push(...(hooks[table]?.beforeDelete?.(found) ?? []));
    const row = readRow(table, id) ?? found; // 훅이 행을 고쳤으면 그 결과가 변경 전 이미지다
    const childIds = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).all(...args) as { id: string }[]).map(r => r.id);
    // 메모는 recordings 를 외래 키로 참조하므로 먼저 지운다 (녹음 → 메모는 순환이 없다)
    if (table === 'recordings') for (const m of childIds('SELECT id FROM recording_marks WHERE recording_id = ?', id)) deleteRow(ctx, 'recording_marks', m, out);
    if (table === 'recordings') for (const n of childIds('SELECT id FROM ai_notes WHERE recording_id = ?', id)) deleteRow(ctx, 'ai_notes', n, out);
    if (table === 'ai_notes') for (const g of childIds('SELECT id FROM ai_note_segments WHERE note_id = ?', id)) deleteRow(ctx, 'ai_note_segments', g, out);
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    logChange(ctx, table, id, 'delete', row, null);
    out.push({ action: 'delete', table, id });
    if (table === 'blocks') {
        if (row.type === 'subpage' && typeof row.ref === 'string') deleteRow(ctx, 'subpages', row.ref, out);
        if (row.type === 'recording' && typeof row.ref === 'string') deleteRow(ctx, 'recordings', row.ref, out);
        for (const c of childIds('SELECT id FROM blocks WHERE parent_id = ?', id)) deleteRow(ctx, 'blocks', c, out);
    } else if (table === 'subpages') {
        for (const c of childIds('SELECT id FROM blocks WHERE doc_id = ?', id)) deleteRow(ctx, 'blocks', c, out);
        for (const p of childIds('SELECT id FROM page_props WHERE doc_id = ?', id)) deleteRow(ctx, 'page_props', p, out);
        // 상위 항목을 지워도 자식 항목은 남는다. 자식의 parent_id 만 비운다 (같은 묶음이라 undo 로 함께 돌아온다)
        for (const c of childIds('SELECT id FROM subpages WHERE parent_id = ?', id)) updateRow(ctx, 'subpages', c, { parent_id: null }, out);
    }
}
// 한 트랜잭션. 중간에 실패하면 되돌리고 예외를 올린다 (index.ts 가 잡아 그 메시지만 버린다)
function tx<T>(fn: () => T): T {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
}

// 컬럼 일부를 고치고 로그한다. patch 는 디코드된 값. 돌려주는 mutation 은 서버가 확정한 값(병합 결과·updated_at)을 싣는다.
function updateRow(ctx: Ctx, table: string, id: string, patch: Row, out: Mutation[]): void {
    const def = TABLES[table];
    if (def.cols.includes('updated_at')) patch.updated_at = Date.now(); // LWW 시각은 서버가 찍는다
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const cur = readRow(table, id)!;
    const before: Row = {};
    for (const c of cols) before[c] = cur[c] ?? null;
    db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map(c => encode(def, c, patch[c])), id);
    logChange(ctx, table, id, 'update', before, patch);
    out.push({ action: 'update', table, row: { id, ...patch } });
}

const dmp = new DiffMatchPatch();
// 텍스트 3-way 병합: base → next 의 편집 각각을, base → current 의 diff 로 위치를 옮겨 current 에 적용한다.
// 삽입은 옮긴 자리에 넣고, 삭제는 그 자리의 글자가 아직 같을 때만 지운다. 같은 글자를 동시에 고친 경우는 양쪽이 모두 남는다.
// (diff-match-patch 의 patch_apply 는 문서 끝의 삭제에서 뒤 글자를 잘라먹어 쓰지 않는다.)
export function merge3(base: string, next: string, current: string): string {
    if (base === current) return next; // 그 사이 아무도 안 고쳤다
    if (base === next) return current; // 내 변경이 없다
    const toCur = dmp.diff_main(base, current);
    let out = current, shift = 0, p = 0;
    for (const [op, text] of dmp.diff_main(base, next)) {
        if (op === 0) { p += text.length; continue; }
        const at = dmp.diff_xIndex(toCur, p) + shift;
        if (op === 1) { out = out.slice(0, at) + text + out.slice(at); shift += text.length; }
        else {
            if (out.slice(at, at + text.length) === text) { out = out.slice(0, at) + out.slice(at + text.length); shift -= text.length; }
            p += text.length;
        }
    }
    return out;
}

// 적용에 성공하면 브로드캐스트할 mutation 들을 순서대로, 버렸으면 빈 배열을 반환한다. group 은 클라이언트가 붙인 묶음 id.
export function apply(m: Mutation, userId: string, group: string): Mutation[] {
    const def = TABLES[m.table];
    if (!def || def.readOnly || !m.action) return [];
    const ctx: Ctx = { userId, group };
    const out: Mutation[] = [];

    if (m.action === 'insert') {
        const full = prepareInsert(m.table, m.row ?? {}, userId);
        if (!full || exists(m.table, full.id)) return [];
        return tx(() => { insertRow(ctx, m.table, full, out); return out; });
    }

    if (m.action === 'update') {
        const id = m.row?.id;
        if (typeof id !== 'string' || !exists(m.table, id)) return [];
        const patch: Row = {};
        for (const [key, value] of Object.entries(m.row)) {
            if (key === 'id' || !def.cols.includes(key) || key === 'updated_at') continue;
            if (m.table === 'recordings' && !RECORDING_CLIENT_COLS.includes(key)) continue; // 종료·파일 연결은 HTTP 경로만 한다
            patch[key] = def.jsonCols.includes(key) ? (value ?? {}) : value;
        }
        if (m.table === 'recordings') {
            if (patch.transcribe !== undefined) patch.transcribe = patch.transcribe ? 1 : 0;
            if (patch.status !== undefined && patch.status !== 'recording' && patch.status !== 'paused') return [];
            const cur = db.prepare('SELECT status FROM recordings WHERE id = ?').get(id) as { status: string };
            if (cur.status === 'stopped') return []; // 종료된 녹음은 제목 외에는 바꾸지 않는다
        }
        if (m.table === 'subpages' && ('kind' in patch || 'db_id' in patch || 'parent_id' in patch)) {
            if (patch.kind !== undefined && patch.kind !== null && !PAGE_KINDS.includes(patch.kind as string)) return [];
            const eff = { ...readRow('subpages', id)!, ...patch };
            if (!parentOk(eff.kind, eff.db_id, eff.parent_id)) return [];
        }
        if (m.table === 'dbs' && patch.kind !== undefined) return []; // DB 의 종류는 바꾸지 않는다
        if (m.table === 'blocks' && typeof patch.text === 'string' && typeof m.base === 'string') {
            const cur = db.prepare('SELECT text FROM blocks WHERE id = ?').get(id) as { text: string };
            patch.text = merge3(m.base, patch.text, cur.text);
        }
        if (!Object.keys(patch).length) return [];
        return tx(() => { updateRow(ctx, m.table, id, patch, out); return out; });
    }

    if (m.action === 'delete') {
        if (typeof m.id !== 'string' || !exists(m.table, m.id)) return [];
        return tx(() => { deleteRow(ctx, m.table, m.id, out); return out; });
    }

    return [];
}

// 묶음 되감기. 그 묶음의 로그 줄을 역순으로 되돌리고(insert → 삭제, delete → 재삽입, update → before 로), 결과를 `as` 묶음으로 다시 로그한다.
// redo 는 되감기 묶음을 다시 되감는 것이다. 자기 묶음만 되감을 수 있다. 되감을 행이 그 사이 사라졌으면 그 줄은 건너뛴다.
export function revert(group: string, as: string, userId: string): Mutation[] {
    const entries = db.prepare('SELECT * FROM changes WHERE group_id = ? ORDER BY id DESC').all(group) as ChangeRow[];
    if (!entries.length || entries.some(e => e.user_id !== userId)) return [];
    if (db.prepare('SELECT 1 FROM changes WHERE group_id = ? LIMIT 1').get(as)) return []; // 같은 되감기의 재전송
    const ctx: Ctx = { userId, group: as, reverts: group };
    const out: Mutation[] = [];
    return tx(() => { revertEntries(ctx, entries, out); return out; });
}
// 로그 줄들(최신이 먼저)을 차례로 되돌린다. revert(묶음 하나)와 restoreVersion(버전 이후 전부)이 함께 쓴다.
function revertEntries(ctx: Ctx, entries: ChangeRow[], out: Mutation[]): void {
    for (const e of entries) {
        if (!TABLES[e.tbl]) continue;
        if (e.action === 'insert') {
            if (exists(e.tbl, e.row_id)) deleteRow(ctx, e.tbl, e.row_id, out);
        } else if (e.action === 'delete') {
            if (!exists(e.tbl, e.row_id) && e.before) insertRow(ctx, e.tbl, JSON.parse(e.before), out);
        } else if (e.action === 'update') {
            if (exists(e.tbl, e.row_id) && e.before) {
                const before = JSON.parse(e.before) as Row;
                delete before.updated_at;
                // 텍스트는 after → before 의 차이를 현재 텍스트에 패치한다. 그 사이 남이 고친 부분을 되감기가 지우지 않게 (전송과 같은 3-way 병합)
                if (e.tbl === 'blocks' && typeof before.text === 'string' && e.after) {
                    const after = JSON.parse(e.after) as Row;
                    const cur = db.prepare('SELECT text FROM blocks WHERE id = ?').get(e.row_id) as { text: string };
                    if (typeof after.text === 'string') before.text = merge3(after.text, before.text, cur.text);
                }
                updateRow(ctx, e.tbl, e.row_id, before, out);
            }
        }
    }
}

// ── 버전 (스냅샷) ──────────────────────────────────────
// 버전은 changes 로그의 한 지점(change_id = 그 시점의 마지막 줄)이다. 실제 이미지는 없고, 되돌아가기는 그 이후 줄을 전부 역순으로 되감는다.
// 설계: docs/2026-09-02-cowork-db-schema.md 의 versions 절 (2026-09-09 version-snapshot).
export type VersionRow = { id: string; name: string; ts: number; change_id: number; auto: number; created_by: string | null };
const VERSION_ID_PREFIX = 'v';
export function createVersion(name: string, userId: string | null, auto: boolean, changeId = lastChangeId(), ts = Date.now()): VersionRow {
    const id = VERSION_ID_PREFIX + ts.toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO versions (id, name, ts, change_id, auto, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, ts, changeId, auto ? 1 : 0, userId);
    sealedId = Math.max(sealedId, changeId);
    return readRow('versions', id) as VersionRow;
}
export const versionMutation = (v: VersionRow): Mutation => ({ action: 'insert', table: 'versions', row: v });
// 자동 버전: 날짜가 바뀐 뒤, 직전 자동 버전 이후 자정 이전까지의 묶음이 AUTO_VERSION_MIN_GROUPS 개 이상이면 자정 이전 마지막 줄까지를 버전으로 남긴다.
// 자정은 서버 로컬 시각 기준이다. 기동 시와 분 단위로 확인하므로 며칠 비어 있다가 돌아와도 한 번에 잡힌다 (그 사이 날들은 묶음 하나로 합쳐진다).
export const AUTO_VERSION_MIN_GROUPS = 10;
export function autoVersionIfDue(now = Date.now()): VersionRow | null {
    const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const lastAuto = (db.prepare('SELECT MAX(change_id) AS id FROM versions WHERE auto = 1').get() as { id: number | null }).id ?? 0;
    const upto = (db.prepare('SELECT MAX(id) AS id FROM changes WHERE ts < ?').get(midnight.getTime()) as { id: number | null }).id ?? 0;
    if (upto <= lastAuto) return null;
    const { n, ts } = db.prepare('SELECT COUNT(DISTINCT group_id) AS n, MAX(ts) AS ts FROM changes WHERE id > ? AND id <= ?').get(lastAuto, upto) as { n: number; ts: number };
    if (n < AUTO_VERSION_MIN_GROUPS) return null;
    const d = new Date(ts);
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 자동`;
    return createVersion(name, null, true, upto, ts);
}
// 버전으로 되돌아가기: 버전 이후의 모든 줄(누구의 것이든)을 역순으로 되감아 `as` 묶음으로 로그한다 (git revert 처럼 이력 위에 얹는다).
// 그 묶음은 되돌린 사용자의 것이라 Ctrl+Z 로 다시 되감을 수 있다. files 행은 서버 관리 대상(GC)이라 건너뛴다 — 블럭의 포인터만 돌아온다.
export function restoreVersion(versionId: string, as: string, userId: string): Mutation[] {
    const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(versionId) as VersionRow | undefined;
    if (!v) return [];
    if (db.prepare('SELECT 1 FROM changes WHERE group_id = ? LIMIT 1').get(as)) return []; // 재전송
    const entries = db.prepare("SELECT * FROM changes WHERE id > ? AND tbl != 'files' ORDER BY id DESC").all(v.change_id) as ChangeRow[];
    if (!entries.length) return [];
    const ctx: Ctx = { userId, group: as, reverts: `version:${versionId}` };
    const out: Mutation[] = [];
    return tx(() => { revertEntries(ctx, entries, out); return out; });
}

// pos 중점 쪼개기의 정밀도 고갈 안전망: 같은 흐름 안에서 이웃 간격이 임계값 미만이면 1..N 정수로 다시 매긴다.
// 흐름은 (doc_id, parent_id, style.tab) 이다 — 탭 블럭의 슬롯들은 parent_id 를 공유하므로 슬롯까지 나눠야 한다. 슬롯끼리는 pos 가 겹쳐도 되고(각자 정렬),
// 탭 전체를 한 흐름으로 보면 다른 슬롯의 같은 pos(빈 슬롯의 첫 블럭은 1) 때문에 불필요하게 다시 매겨져, 그 뒤 undo 가 옛 pos 를 되살릴 때 순서가 흐트러진다 (tabs-polish 2026-09-12).
// 직렬 적용 구조라 정규화 중 경쟁 상태가 없다. true 를 반환하면 호출부가 스냅샷을 다시 브로드캐스트한다. 정규화는 로그하지 않는다 (순서를 바꾸지 않는 재표기).
const POS_EPSILON = 1e-6;
export function normalizePosIfNeeded(m: Mutation): boolean {
    if (m.table !== 'blocks' || m.action === 'delete') return false;
    const id = m.row?.id;
    const found = db.prepare("SELECT doc_id, parent_id, json_extract(style, '$.tab') AS tab FROM blocks WHERE id = ?").get(String(id)) as
        { doc_id: string; parent_id: string | null; tab: string | null } | undefined;
    if (!found) return false;
    const rows = db.prepare("SELECT id, pos FROM blocks WHERE doc_id = ? AND parent_id IS ? AND json_extract(style, '$.tab') IS ? ORDER BY pos")
        .all(found.doc_id, found.parent_id, found.tab) as { id: string; pos: number }[];
    if (!rows.some((r, i) => i > 0 && r.pos - rows[i - 1].pos < POS_EPSILON)) return false;
    const update = db.prepare('UPDATE blocks SET pos = ? WHERE id = ?');
    db.exec('BEGIN');
    rows.forEach((r, i) => update.run(i + 1, r.id));
    db.exec('COMMIT');
    return true;
}

// ── 파일 GC ────────────────────────────────────────────
// 살아 있는 포인터(image·file 블럭의 ref, recordings.file_id)가 없고, 로그에서도 FILE_KEEP_MS 동안 등장하지 않은 파일을 실제로 지운다.
// 로그를 되감아 포인터가 돌아올 수 있는 기간을 지난 뒤에만 지운다. 삭제는 서버 자체 묶음으로 로그한다.
export const FILE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export function orphanFiles(now = Date.now()): string[] {
    const cutoff = now - FILE_KEEP_MS;
    const rows = db.prepare(`
        SELECT f.id FROM files f
        WHERE f.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.ref = f.id AND b.type IN ('image', 'file'))
          AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.file_id = f.id)
          AND NOT EXISTS (SELECT 1 FROM changes c WHERE c.ts > ? AND (c.before LIKE '%' || f.id || '%' OR c.after LIKE '%' || f.id || '%'))
    `).all(cutoff, cutoff) as { id: string }[];
    return rows.map(r => r.id);
}
export function deleteFileRow(id: string, group: string): Mutation[] {
    const out: Mutation[] = [];
    return tx(() => { deleteRow({ userId: null, group }, 'files', id, out); return out; });
}
