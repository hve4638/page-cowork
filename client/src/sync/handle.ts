// 테이블 스코프 핸들. 페이지 조립부가 모듈에 무엇을 허용하는지 선언하는 자리다.
// ro 핸들에는 쓰기 함수가 타입 수준에서 존재하지 않는다 — 잘못 꽂으면 컴파일 에러.
import { type Row, useTableRows, sendMutation, type Mutation } from './store';
import { groupFor } from './history';

export interface RoTable<T extends Row> {
    readonly name: string;
    readonly mode: 'ro' | 'rw';
    useRows(): T[]; // React 훅 — 모듈 컴포넌트 렌더 중에 호출한다
}
export interface RwTable<T extends Row> extends RoTable<T> {
    insert(row: T): boolean;
    update(row: Partial<T> & Row, base?: string): boolean; // base: 텍스트 편집의 출발 텍스트 (blocks.text 3-way 병합용)
    remove(id: string): boolean;
}

export function table<T extends Row>(name: string, mode: 'rw'): RwTable<T>;
export function table<T extends Row>(name: string, mode: 'ro'): RoTable<T>;
export function table<T extends Row>(name: string, mode: 'ro' | 'rw'): RoTable<T> | RwTable<T> {
    const base: RoTable<T> = {
        name,
        mode,
        useRows: () => useTableRows(name) as T[],
    };
    if (mode === 'ro') return base;
    // 모든 쓰기는 undo 묶음 id 를 달고 나간다 (history.groupFor)
    const send = (m: Mutation) => sendMutation(m, groupFor(m));
    return {
        ...base,
        insert: row => send({ action: 'insert', table: name, row }),
        update: (row, base) => send(base === undefined ? { action: 'update', table: name, row } : { action: 'update', table: name, row, base }),
        remove: id => send({ action: 'delete', table: name, id }),
    };
}
