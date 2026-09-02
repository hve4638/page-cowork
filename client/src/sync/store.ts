// 동기화 코어: 스냅샷 + 브로드캐스트를 받아 테이블 저장소를 유지한다.
// 프레임워크 무관한 부분이며, React 는 useSyncExternalStore 로 이 저장소를 구독만 한다.
import { useSyncExternalStore } from 'react';

export type Row = { id: string };
export type Mutation =
    | { action: 'insert'; table: string; row: Row }
    | { action: 'update'; table: string; row: Row } // id 기준 병합 — 나중 것이 이긴다 (LWW)
    | { action: 'delete'; table: string; id: string };

// crypto.randomUUID 는 HTTPS/localhost 밖에서는 없다 — IP 접속을 위해 getRandomValues 로 생성
export const rid = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)), b => (b % 16).toString(16)).join('');
export const clientId = rid(4);

// ── 테이블 저장소 ──────────────────────────────────────
let tables: Record<string, Row[]> = {};
const EMPTY: Row[] = [];
const tableListeners = new Map<string, Set<() => void>>();

function emitTable(name: string) {
    tableListeners.get(name)?.forEach(fn => fn());
}
function subscribeTable(name: string, fn: () => void) {
    if (!tableListeners.has(name)) tableListeners.set(name, new Set());
    tableListeners.get(name)!.add(fn);
    return () => { tableListeners.get(name)!.delete(fn); };
}
export function useTableRows(name: string): Row[] {
    return useSyncExternalStore(fn => subscribeTable(name, fn), () => tables[name] ?? EMPTY);
}

// 배열을 매번 새로 만들어야 React 가 변경을 감지한다
function applyLocal(m: Mutation) {
    const t = tables[m.table];
    if (!t) return;
    if (m.action === 'insert') {
        // 이미 있으면(낙관 적용된 내 insert 의 echo) 서버가 채운 컬럼(updated_at 등)만 덧입힌다
        tables[m.table] = t.some(r => r.id === m.row.id)
            ? t.map(r => (r.id === m.row.id ? { ...r, ...m.row } : r))
            : [...t, m.row];
    } else if (m.action === 'update') {
        tables[m.table] = t.map(r => (r.id === m.row.id ? { ...r, ...m.row } : r));
    } else if (m.action === 'delete') {
        tables[m.table] = t.filter(r => r.id !== m.id);
    }
    emitTable(m.table);
}

// ── 메타 상태 (rev · 연결) ─────────────────────────────
type Meta = { rev: number; connected: boolean; loaded: boolean }; // loaded: 첫 스냅샷을 받았는지 — 빈 테이블과 "아직 모름"을 구분한다
let meta: Meta = { rev: 0, connected: false, loaded: false };
const metaListeners = new Set<() => void>();

function setMeta(patch: Partial<Meta>) {
    meta = { ...meta, ...patch };
    metaListeners.forEach(fn => fn());
}
export function useMeta(): Meta {
    return useSyncExternalStore(
        fn => { metaListeners.add(fn); return () => metaListeners.delete(fn); },
        () => meta,
    );
}

// ── WS 연결 ────────────────────────────────────────────
let ws: WebSocket | null = null;
let shouldReconnect = false;

export function sendMutation(m: Mutation): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) { setMeta({ connected: false }); return false; } // 끊긴 동안의 변경은 거부
    applyLocal(m); // 낙관적 로컬 적용, 서버 rev 는 브로드캐스트로 받는다
    ws.send(JSON.stringify({ type: 'mutate', clientId, m }));
    return true;
}

// 로그인 이후에만 호출한다 — WS 업그레이드 자체가 세션 쿠키로 인증되기 때문
export function connect() {
    if (ws) return;
    shouldReconnect = true;
    open();
}
export function disconnect() {
    shouldReconnect = false;
    ws?.close();
    ws = null;
}

function open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/sync`);
    ws.onopen = () => setMeta({ connected: true });
    ws.onclose = () => {
        setMeta({ connected: false });
        if (shouldReconnect) setTimeout(() => { if (shouldReconnect) open(); }, 2000);
    };
    ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'snapshot') {
            tables = msg.tables; // 재연결 시 서버 상태로 전체 재동기화
            for (const name of Object.keys(tables)) emitTable(name);
            setMeta({ rev: msg.rev, loaded: true });
            return;
        }
        if (msg.type === 'change') {
            // 내가 보낸 것도 다시 적용한다. 서버가 정한 순서가 진실이므로, 내 낙관 적용과 내 echo 사이에
            // 상대의 같은 행 변경이 끼어들어도 모든 클라이언트가 서버와 같은 결과로 수렴한다.
            // (echo 를 건너뛰면 상대 변경이 내 것을 덮은 채 끝나 서버와 어긋난다.) 적용은 멱등이라 중복 무해.
            applyLocal(msg.m);
            setMeta({ rev: msg.rev });
        }
    };
}
