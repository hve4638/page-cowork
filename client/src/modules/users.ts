// 활동 중인 사용자 목록 (GET /api/users 의 id·name). users 는 WS 동기화 테이블이 아니라 HTTP 로 한 번 받아 모듈에 캐시한다.
// 담당자(people 속성)의 이름 표시·선택기가 쓴다. 닉네임 변경은 다음 새로고침에 반영된다 (2026-09-12 project-items).
import { useSyncExternalStore } from 'react';

export type UserRow = { id: string; name: string };

let users: UserRow[] | null = null; // null: 아직 안 받음
let loading = false;
const listeners = new Set<() => void>();
const EMPTY: UserRow[] = [];

function load() {
    if (users || loading) return;
    loading = true;
    fetch('/api/users')
        .then(r => (r.ok ? r.json() : { users: [] }))
        .then(d => { users = d.users as UserRow[]; })
        .catch(() => { users = []; })
        .finally(() => { loading = false; listeners.forEach(fn => fn()); });
}

export function useUsers(): UserRow[] {
    return useSyncExternalStore(
        fn => { listeners.add(fn); load(); return () => { listeners.delete(fn); }; },
        () => users ?? EMPTY,
    );
}
export const userName = (list: UserRow[], id: string) => list.find(u => u.id === id)?.name ?? '(알 수 없음)';
