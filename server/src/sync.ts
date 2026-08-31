// 동기화 대상 테이블과 변경 적용. 모든 변경은 index.ts 의 WS 핸들러를 통해 직렬로 들어온다.
// 같은 행 충돌은 나중 것이 이기고(LWW), 없는 테이블·행 대상은 조용히 버린다 (null 반환).
import { db } from './db.ts';

export type Mutation =
    | { action: 'insert'; table: string; row: Record<string, unknown> }
    | { action: 'update'; table: string; row: Record<string, unknown> }
    | { action: 'delete'; table: string; id: string };

// WS 로 내보내는 테이블만 등재한다. users·sessions 는 동기화 대상이 아니다.
const TABLES: Record<string, { cols: string[]; jsonCols: string[] }> = {
    notices: { cols: ['id', 'text', 'author_id', 'ts'], jsonCols: [] },
    blocks: { cols: ['id', 'doc_id', 'type', 'ref', 'text', 'pos', 'style', 'updated_at'], jsonCols: ['style'] },
};

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
    if (table === 'notices') {
        if (typeof row.text !== 'string') return null;
        return {
            id: row.id,
            text: row.text,
            author_id: userId, // 작성자는 클라이언트를 믿지 않고 세션에서 찍는다
            ts: typeof row.ts === 'number' ? row.ts : Date.now(),
        };
    }
    if (table === 'blocks') {
        if (typeof row.doc_id !== 'string' || typeof row.pos !== 'number') return null;
        return {
            id: row.id,
            doc_id: row.doc_id,
            type: row.type === 'subpage' ? 'subpage' : 'text',
            ref: typeof row.ref === 'string' ? row.ref : null,
            text: typeof row.text === 'string' ? row.text : '',
            pos: row.pos,
            style: JSON.stringify(row.style ?? {}),
            updated_at: Date.now(),
        };
    }
    return null;
}

const exists = (table: string, id: unknown): boolean =>
    !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(String(id));

// 적용에 성공하면 브로드캐스트할 mutation 을, 버렸으면 null 을 반환한다
export function apply(m: Mutation, userId: string): Mutation | null {
    const def = TABLES[m.table];
    if (!def || !m.action) return null;

    if (m.action === 'insert') {
        const full = prepareInsert(m.table, m.row ?? {}, userId);
        if (!full || exists(m.table, full.id)) return null;
        const cols = Object.keys(full);
        db.prepare(`INSERT INTO ${m.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map(c => full[c] as string | number | null));
        return { action: 'insert', table: m.table, row: decodeRow(def, { ...full }) };
    }

    if (m.action === 'update') {
        const id = m.row?.id;
        if (typeof id !== 'string' || !exists(m.table, id)) return null;
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(m.row)) {
            if (key === 'id' || !def.cols.includes(key)) continue;
            patch[key] = def.jsonCols.includes(key) ? JSON.stringify(value ?? {}) : value;
        }
        if (m.table === 'blocks') patch.updated_at = Date.now();
        const cols = Object.keys(patch);
        if (!cols.length) return null;
        db.prepare(`UPDATE ${m.table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
            .run(...cols.map(c => patch[c] as string | number | null), id);
        return m;
    }

    if (m.action === 'delete') {
        if (typeof m.id !== 'string' || !exists(m.table, m.id)) return null;
        db.prepare(`DELETE FROM ${m.table} WHERE id = ?`).run(m.id);
        return m;
    }

    return null;
}

// pos 중점 쪼개기의 정밀도 고갈 안전망: 같은 문서 안에서 이웃 간격이 임계값 미만이면 1..N 정수로 다시 매긴다.
// 직렬 적용 구조라 정규화 중 경쟁 상태가 없다. true 를 반환하면 호출부가 스냅샷을 다시 브로드캐스트한다.
const POS_EPSILON = 1e-6;
export function normalizePosIfNeeded(m: Mutation): boolean {
    if (m.table !== 'blocks' || m.action === 'delete') return false;
    const id = m.row?.id;
    const found = db.prepare('SELECT doc_id FROM blocks WHERE id = ?').get(String(id)) as { doc_id: string } | undefined;
    if (!found) return false;
    const rows = db.prepare('SELECT id, pos FROM blocks WHERE doc_id = ? ORDER BY pos').all(found.doc_id) as
        { id: string; pos: number }[];
    if (!rows.some((r, i) => i > 0 && r.pos - rows[i - 1].pos < POS_EPSILON)) return false;
    const update = db.prepare('UPDATE blocks SET pos = ? WHERE id = ?');
    db.exec('BEGIN');
    rows.forEach((r, i) => update.run(i + 1, r.id));
    db.exec('COMMIT');
    return true;
}
