// 페이지 속성. 본문(blocks)과 별개로 페이지가 가지는 key-value 다 — 마크다운의 frontmatter, Notion DB 의 속성 열에 해당한다.
// 속성 하나가 page_props 행 하나이고 id 는 '<doc_id>:<key>' 라서, 같은 페이지의 다른 속성을 두 사람이 동시에 고쳐도 덮어쓰지 않는다.
// 회의록의 일시·목적이 첫 사용처다. 다른 페이지(회의 보드 등)는 subpages.id 로 이 행을 읽어 값을 쓴다 (propValue).
// 값의 형태는 type 별로 정해져 있다: text → string, number → number|null, select → {value, options}, date → ms|null, daterange → {start, end}, people → users.id[].
// 프로젝트 항목(마일스톤·작업·티켓)의 상태·담당자·기한도 속성이다. 상위 항목만 속성이 아니라 subpages.parent_id 컬럼이고, 이 표가 첫 줄로 함께 그린다 (2026-09-12 project-items).
import { useState } from 'react';
import type { RwTable } from '@/sync/handle';
import { group } from '@/sync/history';
import type { SubpageRow } from './BlockDoc';
import { ITEM_META, isItemKind } from './itemKinds';
import { userName, useUsers } from './users';

export type PropType = 'text' | 'number' | 'select' | 'date' | 'daterange' | 'people';
export type PropValue = string | number | null | string[] | { value: string | null; options: string[] } | { start: number | null; end: number | null };
export type PagePropRow = {
    id: string; // '<doc_id>:<key>'
    doc_id: string;
    key: string;
    type: PropType;
    value: PropValue;
    pos: number;
    updated_at?: number;
};

export const propId = (docId: string, key: string) => `${docId}:${key}`;
export const propValue = (rows: PagePropRow[], docId: string, key: string): PropValue | undefined =>
    rows.find(p => p.doc_id === docId && p.key === key)?.value;
// 날짜형 속성의 ms 값. date 는 그 값, daterange 는 start. 정렬·"다가오는 회의" 판정에 쓴다.
export const propTime = (rows: PagePropRow[], docId: string, key: string): number | null => {
    const v = propValue(rows, docId, key);
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object' && 'start' in v) return v.start;
    return null;
};

export const TYPE_LABEL: Record<PropType, string> = { text: '텍스트', number: '숫자', select: '상태', date: '날짜', daterange: '기간', people: '사람' };
const EMPTY: Record<PropType, PropValue> = { text: '', number: null, select: { value: null, options: [] }, date: null, daterange: { start: null, end: null }, people: [] };
// select 의 현재 값 (없으면 null)
export const propSelect = (rows: PagePropRow[], docId: string, key: string): string | null => {
    const v = propValue(rows, docId, key);
    return v && typeof v === 'object' && 'options' in v ? v.value : null;
};
export const propPeople = (rows: PagePropRow[], docId: string, key: string): string[] => {
    const v = propValue(rows, docId, key);
    return Array.isArray(v) ? v : [];
};

const pad = (n: number) => String(n).padStart(2, '0');
// datetime-local 입력값 ↔ ms. 입력은 로컬 시각이라 타임존 변환 없이 필드만 옮긴다.
export const toLocalInput = (ms: number | null) => {
    if (ms === null) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : null);
export const fmtDateTime = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmtDate = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

const field = 'h-7 px-1.5 rounded-md bg-transparent border border-transparent hover:border-[var(--c-borPri)] focus:border-[var(--c-borPri)] outline-none text-[14px]';

// 사람 목록 편집기: 이름 칩(× 로 제거) + 추가 select. 값은 users.id 배열이라 닉네임이 바뀌어도 끊기지 않는다
export function PeopleEditor({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
    const users = useUsers();
    const rest = users.filter(u => !value.includes(u.id));
    return (
        <span className="flex flex-wrap items-center gap-1">
            {value.map(id => (
                <span key={id} className="inline-flex items-center gap-0.5 h-6 pl-2 pr-1 rounded-full bg-[var(--c-graBacSec)] text-[13px]">
                    {userName(users, id)}
                    <button className="px-0.5 bg-transparent! text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="제외" onClick={() => onChange(value.filter(x => x !== id))}>×</button>
                </span>
            ))}
            {rest.length > 0 && (
                <select className={`${field} w-24 text-[13px] text-[var(--c-texTer)] cursor-pointer`} value="" onChange={e => { if (e.target.value) onChange([...value, e.target.value]); }}>
                    <option value="">+ 추가</option>
                    {rest.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
            )}
            {!value.length && !rest.length && <span className="text-[var(--c-texTer)]">비어 있음</span>}
        </span>
    );
}

// 속성 하나의 값 편집기. 값은 입력마다 바로 동기화한다 (제목 input 과 같은 방식). 입력 필드 자체의 undo 는 브라우저가 한다.
function ValueEditor({ p, onChange }: { p: PagePropRow; onChange: (v: PropValue) => void }) {
    const v = p.value;
    if (p.type === 'text') return <input className={`${field} flex-1 min-w-0`} value={typeof v === 'string' ? v : ''} placeholder="비어 있음" onChange={e => onChange(e.target.value)} />;
    if (p.type === 'number') {
        return <input className={`${field} w-32`} type="number" value={typeof v === 'number' ? v : ''} placeholder="비어 있음" onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    }
    if (p.type === 'date') return <input className={field} type="datetime-local" value={toLocalInput(typeof v === 'number' ? v : null)} onChange={e => onChange(fromLocalInput(e.target.value))} />;
    if (p.type === 'people') return <PeopleEditor value={Array.isArray(v) ? v : []} onChange={onChange} />;
    if (p.type === 'daterange') {
        const r = v && typeof v === 'object' && 'start' in v ? v : { start: null, end: null };
        return (
            <span className="flex items-center gap-1">
                <input className={field} type="datetime-local" value={toLocalInput(r.start)} onChange={e => onChange({ ...r, start: fromLocalInput(e.target.value) })} />
                <span className="text-[var(--c-texTer)]">~</span>
                <input className={field} type="datetime-local" value={toLocalInput(r.end)} onChange={e => onChange({ ...r, end: fromLocalInput(e.target.value) })} />
            </span>
        );
    }
    // select: 지금 값과 선택지. 선택지에 없는 값을 치면 선택지에 추가된다 (별도의 선택지 관리 화면 없이 쓰기 시작할 수 있게).
    const s = v && typeof v === 'object' && 'options' in v ? v : { value: null, options: [] };
    const listId = `prop-options-${p.id}`;
    return (
        <>
            <input
                className={`${field} w-40`} list={listId} value={s.value ?? ''} placeholder="비어 있음"
                onChange={e => {
                    const value = e.target.value || null;
                    onChange({ value, options: value && !s.options.includes(value) ? [...s.options, value] : s.options });
                }}
            />
            <datalist id={listId}>{s.options.map(o => <option key={o} value={o} />)}</datalist>
        </>
    );
}

// 프로젝트 항목 페이지의 첫 줄: 종류와 상위 항목. 상위는 속성이 아니라 subpages.parent_id 이고, 같은 DB 의 한 단계 위 항목 중에서 고른다 (서버가 검증).
function ItemHead({ page, subpages }: { page: SubpageRow; subpages: RwTable<SubpageRow> }) {
    const pages = subpages.useRows();
    if (!isItemKind(page.kind)) return null;
    const meta = ITEM_META[page.kind];
    const parents = meta.parent ? pages.filter(p => p.kind === meta.parent && p.db_id === page.db_id).sort((a, b) => a.title.localeCompare(b.title)) : [];
    const parent = pages.find(p => p.id === page.parent_id);
    return (
        <>
            <div className="flex items-center gap-2 min-h-8">
                <span className="w-28 shrink-0 px-1.5 text-[var(--c-texSec)]">종류</span>
                <span className="px-1.5">{meta.icon} {meta.label}</span>
            </div>
            {meta.parent && (
                <div className="flex items-center gap-2 min-h-8">
                    <span className="w-28 shrink-0 px-1.5 text-[var(--c-texSec)]">상위</span>
                    <select className={`${field} w-56 cursor-pointer`} value={parent ? parent.id : ''} onChange={e => subpages.update({ id: page.id, parent_id: e.target.value || null })}>
                        <option value="">{page.parent_id && !parent ? '(삭제된 상위)' : '없음'}</option>
                        {parents.map(p => <option key={p.id} value={p.id}>{ITEM_META[meta.parent!].icon} {p.title || '제목 없음'}</option>)}
                    </select>
                </div>
            )}
        </>
    );
}

// 페이지 제목 아래의 속성 표. 행마다 이름·형식·값이고, 이름을 바꾸면 id 가 바뀌므로 새 행을 만들고 옛 행을 지운다.
// "+ 속성" 은 이 영역에 마우스를 올렸을 때만 보인다 — 속성이 없는 페이지(홈 등)에서 제목 아래가 비어 보이게.
// page·subpages 를 주면 프로젝트 항목 페이지의 종류·상위 줄을 맨 위에 그린다.
export function PageProps({ docId, props, page, subpages }: { docId: string; props: RwTable<PagePropRow>; page?: SubpageRow; subpages?: RwTable<SubpageRow> }) {
    const rows = props.useRows().filter(p => p.doc_id === docId).sort((a, b) => a.pos - b.pos);
    const [adding, setAdding] = useState(false);
    const add = (key: string) => {
        setAdding(false);
        key = key.trim();
        if (!key || rows.some(p => p.key === key)) return;
        props.insert({ id: propId(docId, key), doc_id: docId, key, type: 'text', value: '', pos: Math.max(0, ...rows.map(p => p.pos)) + 1 });
    };
    const rename = (p: PagePropRow, key: string) => {
        key = key.trim();
        if (!key || key === p.key || rows.some(x => x.key === key)) return;
        group(() => { props.insert({ ...p, id: propId(docId, key), key }); props.remove(p.id); }); // 이름 바꾸기는 새 행 + 옛 행 삭제가 한 묶음
    };
    const setType = (p: PagePropRow, type: PropType) => props.update({ id: p.id, type, value: EMPTY[type] });
    return (
        <div className="group/props mb-3 text-[14px]">
            {page && subpages && <ItemHead page={page} subpages={subpages} />}
            {rows.map(p => (
                <div key={p.id} className="group flex items-center gap-2 min-h-8">
                    <input
                        className={`${field} w-28 shrink-0 text-[var(--c-texSec)]`} defaultValue={p.key} title="속성 이름 (Enter 로 확정)"
                        onBlur={e => rename(p, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                    />
                    <ValueEditor p={p} onChange={value => props.update({ id: p.id, value })} />
                    <select className="opacity-0 group-hover:opacity-100 focus:opacity-100 h-7 text-[12px] text-[var(--c-texTer)] bg-transparent cursor-pointer" value={p.type} title="속성 형식" onChange={e => setType(p, e.target.value as PropType)}>
                        {(Object.keys(TYPE_LABEL) as PropType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                    </select>
                    <button className="opacity-0 group-hover:opacity-100 focus:opacity-100 px-1 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="속성 삭제" onClick={() => props.remove(p.id)}>✕</button>
                </div>
            ))}
            {adding
                ? <input autoFocus className={`${field} w-28 border-[var(--c-borPri)]`} placeholder="속성 이름" onBlur={e => add(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setAdding(false); }} />
                : <button className="h-7 px-1.5 rounded-md text-[13px] text-[var(--c-texTer)] hover:bg-[var(--ca-bacIntTra)] cursor-pointer opacity-0 group-hover/props:opacity-100 focus:opacity-100" onClick={() => setAdding(true)}>+ 속성</button>}
        </div>
    );
}
