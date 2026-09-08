// 세션 전역 undo/redo 스택 (2026-09-08 undo-model). 설계: docs/2026-09-02-cowork-db-schema.md 의 changes 절.
// 스택의 항목은 "내가 보낸 묶음(group) id" 이고, undo 는 서버에 그 묶음의 되감기(revert)를 요청한다 — 되돌리는 계산은 서버가 로그의 변경 전 이미지로 한다.
// 그래서 연쇄 삭제된 손자·서브페이지 본문·녹음 행까지 함께 돌아온다. 되감기 결과도 새 묶음이라 redo 는 그 묶음을 다시 되감는 것이다.
// 스택은 이 브라우저의 메모리에만 있다. 새로고침하면 비고, 서버의 최신 상태에서 시작한다. 다른 사람의 변경은 스택에 오르지 않는다.
// 묶음 규칙: sendMutation 은 열려 있는 묶음(run/group 안)이 있으면 거기 붙고, 없으면 조작 하나짜리 묶음이 된다.
// 조작 하나짜리 묶음이 같은 행의 update 로 연달아 오면(제목 input 타이핑) 1초 안에서는 같은 묶음을 이어 쓴다 — 서버가 한 로그 줄로 amend 한다.
import { useSyncExternalStore } from 'react';
import { rid, sendRevert, type Mutation } from './store';

const undoStack: string[] = [];
let redoStack: string[] = [];
// 사이드바 "내 변경사항" 이 스택을 구독한다. 스택이 바뀔 때마다 새 스냅샷 객체를 만든다
type Snapshot = { undo: string[]; redo: string[] };
let snap: Snapshot = { undo: [], redo: [] };
const listeners = new Set<() => void>();
function changed() { snap = { undo: [...undoStack], redo: [...redoStack] }; listeners.forEach(fn => fn()); }
export const useHistory = (): Snapshot => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => snap);
let current: string | null = null; // run/group 으로 열려 있는 묶음
let silentGroup: string | null = null; // silent 안: 스택에 올리지 않는 묶음
const used = new Set<string>(); // 실제로 mutation 을 하나라도 보낸 묶음만 스택에 오른다
const flushers = new Set<() => void>(); // undo 직전에 열린 타이핑 덩어리를 닫는 콜백 (BlockDoc 이 등록)
let lastOneShot: { group: string; key: string; at: number } | null = null;
const ONE_SHOT_JOIN_MS = 1000;

export const newGroup = () => rid(8);

// fn 이 보내는 mutation 을 g 묶음에 붙인다. 이미 열린 묶음 안이면(중첩) 바깥 묶음이 이긴다.
export function run<T>(g: string, fn: () => T): T {
    if (current) return fn();
    current = g;
    try { return fn(); } finally { current = null; }
}
// 보낸 게 있으면 스택에 올린다. 새 조작이므로 redo 는 무효.
export function commit(g: string): void {
    if (!used.has(g) || undoStack.includes(g)) return;
    undoStack.push(g);
    redoStack = [];
    changed();
}
// 새 묶음 하나로 fn 을 실행하고 스택에 올린다 — 구조 조작 하나(삽입·삭제·이동·표 행 추가 등)의 기본 형태.
export function group<T>(fn: () => T): T {
    const g = newGroup();
    const r = run(g, fn);
    commit(g);
    return r;
}
// 스택에 올리지 않는 변경 (녹음 상태 갱신처럼 사용자 조작이 아닌 것)
export function silent<T>(fn: () => T): T {
    if (silentGroup) return fn();
    silentGroup = newGroup();
    try { return fn(); } finally { silentGroup = null; }
}
// 스택 맨 위가 g 면 뺀다 (꼬리 클릭으로 만들었다가 바로 거둔 빈 블럭처럼 흔적을 남기지 않을 조작)
export function drop(g: string): void {
    if (undoStack.at(-1) === g) { undoStack.pop(); changed(); }
}
// sendMutation 이 mutation 에 붙일 묶음 id
export function groupFor(m: Mutation): string {
    if (silentGroup) return silentGroup;
    if (current) { used.add(current); return current; }
    const key = m.action === 'update' ? `${m.table}:${m.row.id}` : '';
    const now = Date.now();
    if (key && lastOneShot && lastOneShot.key === key && now - lastOneShot.at < ONE_SHOT_JOIN_MS && undoStack.at(-1) === lastOneShot.group) {
        lastOneShot.at = now;
        return lastOneShot.group;
    }
    const g = newGroup();
    used.add(g);
    commit(g);
    lastOneShot = key ? { group: g, key, at: now } : null;
    return g;
}

export const onBeforeUndo = (fn: () => void) => { flushers.add(fn); return () => { flushers.delete(fn); }; };
export function undo(): void {
    flushers.forEach(fn => fn());
    const g = undoStack.pop();
    if (!g) return;
    const as = newGroup();
    if (sendRevert(g, as)) redoStack.push(as); else undoStack.push(g);
    lastOneShot = null;
    changed();
}
export function redo(): void {
    flushers.forEach(fn => fn());
    const g = redoStack.pop();
    if (!g) return;
    const as = newGroup();
    if (sendRevert(g, as)) undoStack.push(as); else redoStack.push(g);
    lastOneShot = null;
    changed();
}

// Ctrl+Z / Ctrl+Shift+Z. 입력 필드(제목·속성·패널의 input) 안에서는 브라우저의 입력 undo 에 맡긴다.
export function installKeys(): () => void {
    const h = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
        if (e.isComposing) return; // 한글 조합 중에는 undo 를 건드리지 않는다
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
}
