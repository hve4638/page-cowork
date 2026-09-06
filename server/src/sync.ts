// 동기화 대상 테이블과 변경 적용. 모든 변경은 index.ts 의 WS 핸들러를 통해 직렬로 들어온다.
// 같은 행 충돌은 나중 것이 이기고(LWW), 없는 테이블·행 대상은 조용히 버린다 (빈 배열 반환).
// 삭제는 연쇄될 수 있어 적용된 mutation 을 여러 개 돌려준다: 링크 블럭 → 서브페이지 → 그 문서의 블럭들, 부모 블럭 → 자식 블럭들(표의 칸).
import { db, HOME_PAGE_ID } from './db.ts';

export type Mutation =
    | { action: 'insert'; table: string; row: Record<string, unknown> }
    | { action: 'update'; table: string; row: Record<string, unknown> }
    | { action: 'delete'; table: string; id: string };

// WS 로 내보내는 테이블만 등재한다. users·sessions 는 동기화 대상이 아니다.
// readOnly 테이블(files)은 스냅샷·브로드캐스트로 내려가기만 하고, 클라이언트의 mutation 은 버린다 — 행은 업로드 API 가 만든다.
const TABLES: Record<string, { cols: string[]; jsonCols: string[]; readOnly?: boolean }> = {
    blocks: { cols: ['id', 'doc_id', 'parent_id', 'type', 'ref', 'text', 'pos', 'style', 'updated_at'], jsonCols: ['style'] },
    subpages: { cols: ['id', 'title', 'pos', 'created_by', 'created_at', 'updated_at', 'kind', 'board_id', 'deleted_at'], jsonCols: [] },
    page_props: { cols: ['id', 'doc_id', 'key', 'type', 'value', 'pos', 'updated_at'], jsonCols: ['value'] },
    files: { cols: ['id', 'name', 'mime', 'size', 'author_id', 'created_at'], jsonCols: [], readOnly: true },
    recent_edits: { cols: ['id', 'user_id', 'doc_id', 'updated_at'], jsonCols: [], readOnly: true },
    // 녹음 상태(status·duration_ms·segment_started_at)는 녹음자 클라이언트가 WS 로 갱신하고, 종료·파일 연결은 HTTP(recordings.ts)가 한다.
    recordings: { cols: ['id', 'title', 'status', 'started_by', 'started_at', 'duration_ms', 'segment_started_at', 'file_id', 'last_chunk_at', 'created_at', 'updated_at'], jsonCols: [] },
    recording_marks: { cols: ['id', 'recording_id', 'offset_ms', 'text', 'author_id', 'created_at'], jsonCols: [] },
};
// callout·toggle 은 텍스트를 담는 특수 블럭, table 은 자식 cell(parent_id = 표 id)을 거느리는 첫 중첩 조립품이다.
// 클라이언트가 WS 로 고칠 수 있는 recordings 컬럼. status 는 recording|paused 사이만 오간다 (stopped 는 HTTP 종료가 찍는다).
const RECORDING_CLIENT_COLS = ['title', 'status', 'duration_ms', 'segment_started_at', 'last_chunk_at'];
// tabs 는 표처럼 자식(parent_id = 탭 블럭, style.tab = 슬롯)을 거느리는 조립품이고, 자식은 어떤 type 이든 될 수 있다(중첩 흐름).
// meetings 는 회의 보드: ref 가 보드 키(uuid)이고 subpages.board_id 가 그 키를 참조한다. 키는 행이 아니라서 보드 블럭을 지워도 회의록은 남고, undo 로 블럭이 같은 키로 돌아오면 다시 보인다.
const BLOCK_TYPES = ['text', 'subpage', 'image', 'file', 'callout', 'table', 'cell', 'recording', 'toggle', 'tabs', 'meetings'];
const PROP_TYPES = ['text', 'number', 'select', 'date', 'daterange'];

function decodeRow(def: { jsonCols: string[] }, row: Record<string, unknown>): Record<string, unknown> {
    for (const col of def.jsonCols) {
        try { row[col] = JSON.parse(String(row[col] ?? '{}')); } catch { row[col] = {}; }
    }
    return row;
}

export function snapshot(): Record<string, unknown[]> {
    const tables: Record<string, unknown[]> = {};
    for (const [name, def] of Object.entries(TABLES)) {
        tables[name] = (db.prepare(`SELECT * FROM ${name}`).all() as Record<string, unknown>[])
            .map(row => decodeRow(def, row));
    }
    return tables;
}

// 테이블별로 컬럼을 검증·보정해서 INSERT 할 완전한 행을 만든다. 형태가 맞지 않으면 null.
function prepareInsert(table: string, row: Record<string, unknown>, userId: string): Record<string, unknown> | null {
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
            style: JSON.stringify(row.style ?? {}),
            updated_at: Date.now(),
        };
    }
    if (table === 'subpages') {
        return {
            id: row.id,
            title: typeof row.title === 'string' ? row.title : '',
            pos: typeof row.pos === 'number' ? row.pos : Date.now(),
            created_by: userId,
            created_at: Date.now(),
            updated_at: Date.now(),
            kind: row.kind === 'meeting' ? 'meeting' : null,
            board_id: typeof row.board_id === 'string' ? row.board_id : null,
            deleted_at: null,
        };
    }
    if (table === 'page_props') {
        if (typeof row.doc_id !== 'string' || typeof row.key !== 'string' || !row.key || !PROP_TYPES.includes(row.type as string)) return null;
        return {
            id: row.id,
            doc_id: row.doc_id,
            key: row.key,
            type: row.type as string,
            value: JSON.stringify(row.value ?? null),
            pos: typeof row.pos === 'number' ? row.pos : Date.now(),
            updated_at: Date.now(),
        };
    }
    if (table === 'recordings') {
        return {
            id: row.id,
            title: typeof row.title === 'string' ? row.title : '',
            status: 'recording',
            started_by: userId,
            started_at: Date.now(),
            duration_ms: 0,
            segment_started_at: Date.now(),
            file_id: null,
            last_chunk_at: Date.now(),
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

// 링크 블럭이 서브페이지의 유일한 입구라서, 링크 블럭 삭제가 참조 페이지와 그 문서의 블럭까지 연쇄된다 (재귀).
// 서브페이지 행을 먼저 지우므로 자기 자신을 가리키는 링크가 있어도 순환하지 않는다.
// 부모 블럭(표)을 지우면 parent_id 로 매달린 자식(칸)도 함께 지운다. 자기 행을 먼저 지우므로 순환하지 않는다.
function deleteBlock(id: string, out: Mutation[]): void {
    const row = db.prepare('SELECT type, ref FROM blocks WHERE id = ?').get(id) as { type: string; ref: string | null } | undefined;
    if (!row) return;
    db.prepare('DELETE FROM blocks WHERE id = ?').run(id);
    out.push({ action: 'delete', table: 'blocks', id });
    if (row.type === 'subpage' && row.ref) deleteSubpage(row.ref, out);
    if (row.type === 'recording' && row.ref) deleteRecording(row.ref, out);
    const children = db.prepare('SELECT id FROM blocks WHERE parent_id = ?').all(id) as { id: string }[];
    for (const c of children) deleteBlock(c.id, out);
}
function deleteSubpage(id: string, out: Mutation[]): void {
    if (id === HOME_PAGE_ID || !exists('subpages', id)) return; // 홈 행은 지울 수 없다
    db.prepare('DELETE FROM subpages WHERE id = ?').run(id);
    out.push({ action: 'delete', table: 'subpages', id });
    const children = db.prepare('SELECT id FROM blocks WHERE doc_id = ?').all(id) as { id: string }[];
    for (const c of children) deleteBlock(c.id, out);
    const recents = db.prepare('SELECT id FROM recent_edits WHERE doc_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM recent_edits WHERE doc_id = ?').run(id);
    for (const r of recents) out.push({ action: 'delete', table: 'recent_edits', id: r.id });
    const props = db.prepare('SELECT id FROM page_props WHERE doc_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM page_props WHERE doc_id = ?').run(id);
    for (const p of props) out.push({ action: 'delete', table: 'page_props', id: p.id });
}

// ── 최근 편집 기록 (사이드바) ──────────────────────────
// mutation 이 편집하는 문서 id. apply 전에 불러야 한다 — 삭제되는 블럭의 doc_id 는 지운 뒤엔 알 수 없다.
// 서브페이지 삭제는 편집으로 치지 않는다 (그 페이지의 기록은 deleteSubpage 가 연쇄 삭제한다).
export function editedDoc(m: Mutation): string | null {
    if (m.table === 'blocks') {
        if (m.action === 'insert') return typeof m.row?.doc_id === 'string' ? m.row.doc_id : null;
        const id = m.action === 'update' ? m.row?.id : m.id;
        const found = db.prepare('SELECT doc_id FROM blocks WHERE id = ?').get(String(id)) as { doc_id: string } | undefined;
        return found?.doc_id ?? null;
    }
    if (m.table === 'subpages' && m.action === 'update') return typeof m.row?.id === 'string' ? m.row.id : null;
    return null;
}

// 타이핑마다 브로드캐스트하지 않도록, 같은 (user, doc) 행은 이 간격 안에서는 다시 찍지 않는다.
const RECENT_THROTTLE_MS = 30_000;
export function touchRecent(userId: string, docId: string): Mutation | null {
    const id = `${userId}:${docId}`;
    const now = Date.now();
    const found = db.prepare('SELECT updated_at FROM recent_edits WHERE id = ?').get(id) as { updated_at: number } | undefined;
    if (found) {
        if (now - found.updated_at < RECENT_THROTTLE_MS) return null;
        db.prepare('UPDATE recent_edits SET updated_at = ? WHERE id = ?').run(now, id);
        return { action: 'update', table: 'recent_edits', row: { id, updated_at: now } };
    }
    const row = { id, user_id: userId, doc_id: docId, updated_at: now };
    db.prepare('INSERT INTO recent_edits (id, user_id, doc_id, updated_at) VALUES (?, ?, ?, ?)').run(id, userId, docId, now);
    return { action: 'insert', table: 'recent_edits', row };
}

// 링크 블럭이 녹음의 유일한 입구라서 녹음 행과 그 메모도 함께 지운다. 청크·완성 파일 실체는 남는다 (GC 는 범위 밖).
// 녹음 중이던 탭은 자기 행이 사라진 것을 보고 녹음기를 멈춘다 (client recorder 스토어).
function deleteRecording(id: string, out: Mutation[]): void {
    if (!exists('recordings', id)) return;
    const marks = db.prepare('SELECT id FROM recording_marks WHERE recording_id = ?').all(id) as { id: string }[];
    db.prepare('DELETE FROM recording_marks WHERE recording_id = ?').run(id);
    db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
    for (const m of marks) out.push({ action: 'delete', table: 'recording_marks', id: m.id });
    out.push({ action: 'delete', table: 'recordings', id });
}

// 적용에 성공하면 브로드캐스트할 mutation 들을 순서대로, 버렸으면 빈 배열을 반환한다
export function apply(m: Mutation, userId: string): Mutation[] {
    const def = TABLES[m.table];
    if (!def || def.readOnly || !m.action) return [];

    if (m.action === 'insert') {
        const full = prepareInsert(m.table, m.row ?? {}, userId);
        if (!full || exists(m.table, full.id)) return [];
        const cols = Object.keys(full);
        db.prepare(`INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map(c => full[c] as string | number | null));
        return [{ action: 'insert', table: m.table, row: decodeRow(def, { ...full }) }];
    }

    if (m.action === 'update') {
        const id = m.row?.id;
        if (typeof id !== 'string' || !exists(m.table, id)) return [];
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(m.row)) {
            if (key === 'id' || !def.cols.includes(key)) continue;
            if (m.table === 'recordings' && !RECORDING_CLIENT_COLS.includes(key)) continue; // 종료·파일 연결은 HTTP 경로만 한다
            patch[key] = def.jsonCols.includes(key) ? JSON.stringify(value ?? {}) : value;
        }
        if (m.table === 'recordings') {
            if (patch.status !== undefined && patch.status !== 'recording' && patch.status !== 'paused') return [];
            const cur = db.prepare('SELECT status FROM recordings WHERE id = ?').get(id) as { status: string };
            if (cur.status === 'stopped') return []; // 종료된 녹음은 제목 외에는 바꾸지 않는다
        }
        if (def.cols.includes('updated_at')) patch.updated_at = Date.now(); // LWW 시각은 서버가 찍는다
        const cols = Object.keys(patch);
        if (!cols.length) return [];
        db.prepare(`UPDATE ${m.table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
            .run(...cols.map(c => patch[c] as string | number | null), id);
        return [m];
    }

    if (m.action === 'delete') {
        if (typeof m.id !== 'string' || !exists(m.table, m.id)) return [];
        const out: Mutation[] = [];
        db.exec('BEGIN');
        if (m.table === 'blocks') deleteBlock(m.id, out);
        else if (m.table === 'subpages') deleteSubpage(m.id, out);
        else {
            db.prepare(`DELETE FROM ${m.table} WHERE id = ?`).run(m.id);
            out.push(m);
        }
        db.exec('COMMIT');
        return out;
    }

    return [];
}

// pos 중점 쪼개기의 정밀도 고갈 안전망: 같은 (doc_id, parent_id) 안에서 이웃 간격이 임계값 미만이면 1..N 정수로 다시 매긴다.
// 직렬 적용 구조라 정규화 중 경쟁 상태가 없다. true 를 반환하면 호출부가 스냅샷을 다시 브로드캐스트한다.
const POS_EPSILON = 1e-6;
export function normalizePosIfNeeded(m: Mutation): boolean {
    if (m.table !== 'blocks' || m.action === 'delete') return false;
    const id = m.row?.id;
    const found = db.prepare('SELECT doc_id, parent_id FROM blocks WHERE id = ?').get(String(id)) as { doc_id: string; parent_id: string | null } | undefined;
    if (!found) return false;
    const rows = db.prepare('SELECT id, pos FROM blocks WHERE doc_id = ? AND parent_id IS ? ORDER BY pos').all(found.doc_id, found.parent_id) as
        { id: string; pos: number }[];
    if (!rows.some((r, i) => i > 0 && r.pos - rows[i - 1].pos < POS_EPSILON)) return false;
    const update = db.prepare('UPDATE blocks SET pos = ? WHERE id = ?');
    db.exec('BEGIN');
    rows.forEach((r, i) => update.run(i + 1, r.id));
    db.exec('COMMIT');
    return true;
}
