// DB: 앱 안의 이름 있는 묶음 (dbs 테이블, 데이터베이스 접속과 무관). 회의 보드와 마일스톤·작업·티켓 보드 블럭이 ref 로 DB 를 가리키고,
// 회의록·항목 페이지는 subpages.db_id 로 DB 에 속한다. 같은 DB 를 가리키는 블럭은 같은 목록을 보인다 (사용자 결정 2026-09-12 project-items).
// 종류(kind)별로 고를 수 있는 DB 가 다르다: 회의 보드는 meeting, 항목 보드 셋은 project DB 하나를 공유한다.
// 블럭을 만들 때는 pickDb(모달, Promise) 로 고르거나 새로 만들고, 만든 뒤에는 보드 설정(⚙)의 DbSettings 로 바꾸거나 이름·설명을 고친다. 삭제 UI 는 아직 없다.
import { useState } from 'react';
import { create } from 'zustand';
import { table } from '@/sync/handle';
import { rid } from '@/sync/store';

export type DbKind = 'meeting' | 'project';
export type DbRow = {
    id: string;
    kind: DbKind;
    name: string;
    description: string;
    created_by?: string; created_at?: number; updated_at?: number; // 서버가 찍는다
};
export const DB_KIND_LABEL: Record<DbKind, string> = { meeting: '회의', project: '프로젝트' };
export const dbName = (rows: DbRow[], id: string | undefined) => { const d = rows.find(x => x.id === id); return d ? d.name || '이름 없음' : '삭제된 DB'; };

const field = 'h-9 px-2 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px]';
const pill = (accent?: boolean) => `h-8 px-3 rounded-full text-[13px] cursor-pointer disabled:opacity-50 ${accent ? 'font-medium bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95' : 'bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!'}`;

// 새 DB 행. 이름이 비면 종류 이름으로 둔다
function newDb(kind: DbKind, name: string, description: string): DbRow {
    return { id: rid(16), kind, name: name.trim() || DB_KIND_LABEL[kind], description: description.trim() };
}

// 새 DB 입력 줄 (이름·설명). 선택 모달과 보드 설정이 함께 쓴다
function NewDbForm({ kind, onCreate, onCancel }: { kind: DbKind; onCreate: (row: DbRow) => void; onCancel: () => void }) {
    const [name, setName] = useState('');
    const [desc, setDesc] = useState('');
    return (
        <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); onCreate(newDb(kind, name, desc)); }}>
            <input autoFocus className={field} placeholder={`새 ${DB_KIND_LABEL[kind]} DB 이름`} value={name} onChange={e => setName(e.target.value)} />
            <input className={field} placeholder="설명 (선택)" value={desc} onChange={e => setDesc(e.target.value)} />
            <div className="flex gap-2 justify-end">
                <button type="button" className={pill()} onClick={onCancel}>취소</button>
                <button type="submit" className={pill(true)}>만들기</button>
            </div>
        </form>
    );
}

// ── 선택 모달 (블럭 생성 시) ──────────────────────────
// '/' 명령이 블럭을 꽂기 전에 부른다. Promise 는 고른 DB 의 id, 취소면 null. 모달 자체는 App 이 DbPickerHost 로 한 번 그린다.
type Pending = { kind: DbKind; resolve: (id: string | null) => void };
const usePicker = create<{ pending: Pending | null; set: (p: Pending | null) => void }>(set => ({ pending: null, set: pending => set({ pending }) }));
export function pickDb(kind: DbKind): Promise<string | null> {
    return new Promise(resolve => {
        const prev = usePicker.getState().pending;
        if (prev) prev.resolve(null);
        usePicker.getState().set({ kind, resolve });
    });
}
export function DbPickerHost() {
    const pending = usePicker(s => s.pending);
    const dbs = table<DbRow>('dbs', 'rw');
    const rows = dbs.useRows();
    const [creating, setCreating] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);
    if (!pending) return null;
    const { kind } = pending;
    const list = rows.filter(d => d.kind === kind).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const done = (id: string | null) => { pending.resolve(id); usePicker.getState().set(null); setCreating(false); setPicked(null); };
    const create = (row: DbRow) => { if (dbs.insert(row)) done(row.id); };
    const cur = picked ?? list[0]?.id ?? null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => done(null)}>
            <div className="w-80 rounded-lg bg-[var(--c-bacPri)] shadow-xl p-5 flex flex-col gap-4 text-sm" onClick={e => e.stopPropagation()}>
                <div className="text-[15px] font-medium">{DB_KIND_LABEL[kind]} DB 선택</div>
                {creating || !list.length
                    ? <NewDbForm kind={kind} onCreate={create} onCancel={() => (list.length ? setCreating(false) : done(null))} />
                    : (
                        <>
                            <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                                {list.map(d => (
                                    <label key={d.id} className={`flex items-start gap-2 px-2 py-1.5 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)] ${cur === d.id ? 'bg-[var(--ca-bacIntTra)]' : ''}`}>
                                        <input type="radio" className="mt-1" name="db" checked={cur === d.id} onChange={() => setPicked(d.id)} />
                                        <span className="flex-1 min-w-0">
                                            <span className="block truncate">{d.name || '이름 없음'}</span>
                                            {d.description && <span className="block truncate text-[12px] text-[var(--c-texTer)]">{d.description}</span>}
                                        </span>
                                    </label>
                                ))}
                            </div>
                            <div className="flex gap-2 justify-between">
                                <button className={pill()} onClick={() => setCreating(true)}>+ 새 DB</button>
                                <span className="flex gap-2">
                                    <button className={pill()} onClick={() => done(null)}>취소</button>
                                    <button className={pill(true)} disabled={!cur} onClick={() => done(cur)}>선택</button>
                                </span>
                            </div>
                        </>
                    )}
            </div>
        </div>
    );
}

// ── 보드 설정 안의 DB 항목 ────────────────────────────
// 같은 종류의 DB 목록에서 고르고(onChange 가 블럭의 ref 를 바꾼다), 고른 DB 의 이름·설명을 바로 고친다 (입력마다 동기화, undo 없음 — 속성 편집과 같은 취급).
export function DbSettings({ kind, value, onChange }: { kind: DbKind; value: string | undefined; onChange: (id: string) => void }) {
    const dbs = table<DbRow>('dbs', 'rw');
    const rows = dbs.useRows();
    const [creating, setCreating] = useState(false);
    const list = rows.filter(d => d.kind === kind).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const cur = list.find(d => d.id === value);
    const create = (row: DbRow) => { if (dbs.insert(row)) { onChange(row.id); setCreating(false); } };
    return (
        <>
            <label className="flex flex-col gap-1">
                <span className="text-[12px] text-[var(--c-texSec)]">DB</span>
                <span className="flex gap-2">
                    <select className={`${field} flex-1 cursor-pointer`} value={cur?.id ?? ''} onChange={e => onChange(e.target.value)}>
                        {!cur && <option value="">{value ? '삭제된 DB' : '선택하세요'}</option>}
                        {list.map(d => <option key={d.id} value={d.id}>{d.name || '이름 없음'}</option>)}
                    </select>
                    <button className={pill()} onClick={() => setCreating(c => !c)}>+ 새 DB</button>
                </span>
            </label>
            {creating && <NewDbForm kind={kind} onCreate={create} onCancel={() => setCreating(false)} />}
            {cur && !creating && (
                <>
                    <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-[var(--c-texSec)]">DB 이름</span>
                        <input className={field} value={cur.name} onChange={e => dbs.update({ id: cur.id, name: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-[var(--c-texSec)]">설명</span>
                        <input className={field} value={cur.description} placeholder="이 DB 가 무엇을 담는지" onChange={e => dbs.update({ id: cur.id, description: e.target.value })} />
                    </label>
                </>
            )}
        </>
    );
}
