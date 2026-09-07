// 페이지 속성. 본문(blocks)과 별개로 페이지가 가지는 key-value 다 — 마크다운의 frontmatter, Notion DB 의 속성 열에 해당한다.
// 속성 하나가 page_props 행 하나이고 id 는 '<doc_id>:<key>' 라서, 같은 페이지의 다른 속성을 두 사람이 동시에 고쳐도 덮어쓰지 않는다.
// 회의록의 일시·목적이 첫 사용처다. 다른 페이지(회의 보드 등)는 subpages.id 로 이 행을 읽어 값을 쓴다 (propValue).
// 값의 형태는 type 별로 정해져 있다: text → string, number → number|null, select → {value, options}, date → ms|null, daterange → {start, end}.
import { useState } from 'react';
import type { RwTable } from '@/sync/handle';

export type PropType = 'text' | 'number' | 'select' | 'date' | 'daterange';
export type PropValue = string | number | null | { value: string | null; options: string[] } | { start: number | null; end: number | null };
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

const TYPE_LABEL: Record<PropType, string> = { text: '텍스트', number: '숫자', select: '상태', date: '날짜', daterange: '기간' };
const EMPTY: Record<PropType, PropValue> = { text: '', number: null, select: { value: null, options: [] }, date: null, daterange: { start: null, end: null } };

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

// 속성 하나의 값 편집기. 값은 입력마다 바로 동기화한다 (제목 input 과 같은 방식). 입력 필드 자체의 undo 는 브라우저가 한다.
function ValueEditor({ p, onChange }: { p: PagePropRow; onChange: (v: PropValue) => void }) {
    const v = p.value;
    if (p.type === 'text') return <input className={`${field} flex-1 min-w-0`} value={typeof v === 'string' ? v : ''} placeholder="비어 있음" onChange={e => onChange(e.target.value)} />;
    if (p.type === 'number') {
        return <input className={`${field} w-32`} type="number" value={typeof v === 'number' ? v : ''} placeholder="비어 있음" onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    }
    if (p.type === 'date') return <input className={field} type="datetime-local" value={toLocalInput(typeof v === 'number' ? v : null)} onChange={e => onChange(fromLocalInput(e.target.value))} />;
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

// 페이지 제목 아래의 속성 표. 행마다 이름·형식·값이고, 이름을 바꾸면 id 가 바뀌므로 새 행을 만들고 옛 행을 지운다.
// "+ 속성" 은 이 영역에 마우스를 올렸을 때만 보인다 — 속성이 없는 페이지(홈 등)에서 제목 아래가 비어 보이게.
export function PageProps({ docId, props }: { docId: string; props: RwTable<PagePropRow> }) {
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
        props.insert({ ...p, id: propId(docId, key), key });
        props.remove(p.id);
    };
    const setType = (p: PagePropRow, type: PropType) => props.update({ id: p.id, type, value: EMPTY[type] });
    return (
        <div className="group/props mb-3 text-[14px]">
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
