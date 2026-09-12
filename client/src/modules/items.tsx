// 프로젝트 항목 보드 블럭 (milestones · works · tickets). 회의 보드와 같은 조립이다: ref 가 DB(dbs.id, kind=project)이고, 같은 DB 의 그 kind 페이지를 그린다.
// 세 종류가 각각 다른 블럭이고 한 화면에 모으는 것은 사용자가 /탭 안에 넣어서 한다 (사용자 결정 2026-09-12). 통합 칸반·계층 선택·2차원 보드는 없다.
// 보드마다 보는 목적이 다르다 (사용자 결정 2026-09-13, docs/2026-09-13-project-items-board-proposal.html):
//   마일스톤 보드 = 트리(개요). 마일스톤 줄을 펼치면 작업 → 티켓이 들여쓰기로 보이고, 줄마다 상태 배지·담당자·기한·하위 집계가 붙는다. 줄 끝 "+ 작업/티켓" 은 제목만 받아 그 자리에 만든다.
//   작업·티켓 보드 = 상태 칸반. 열은 '상태' 속성값(todo·doing·done), 위에 상위 필터 칩, 열 아래 즉시 생성(제목만, 그 상태·필터 중인 상위로). 카드 드래그가 상태 속성을 update 한다.
// 즉시 생성은 ItemForm 과 같은 내장 매크로 "새 <종류>" 를 한 undo 묶음으로 실행한다 (담당자·기한은 비움). 상태 배지를 누르면 그 자리에서 바꾼다.
// 카드·줄 클릭은 패널, Alt+클릭은 이동, × 는 삭제(undo 가능). 헤더의 "+ 새 항목" 은 오른쪽 패널의 생성 창(ItemForm)을 연다.
// BlockDoc 이 블럭 하나마다 이 컴포넌트를 그린다. 블럭 문서의 드래그(손잡이 이동·파일 드롭)와 섞이지 않게 드래그 이벤트는 여기서 멈춘다.
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { table, type RwTable } from '@/sync/handle';
import { group } from '@/sync/history';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { fmtDate, propId, propPeople, propSelect, propTime, type PagePropRow } from './props';
import { ASSIGNEE_KEY, DUE_KEY, ITEM_META, STATUS_KEY, STATUSES, type ItemKind } from './itemKinds';
import { dbName, type DbRow } from './dbs';
import { BUILTIN_MACROS, itemMacroId, runMacro } from './macros';
import { userName, useUsers, type UserRow } from './users';

const titleOf = (p: SubpageRow | undefined) => (p ? p.title || '제목 없음' : '');
type Status = (typeof STATUSES)[number];
const DRAG_MIME = 'application/x-cowork-item';
// 상태 색: 배지(글자·배경)와 카드 배경. 노션 라이트 팔레트의 초록·파랑·회색
const STATUS_STYLE: Record<Status, { fg: string; bg: string; card: string }> = {
    todo: { fg: '#2e6b3f', bg: '#e8f1ec', card: '#f3f8f4' },
    doing: { fg: '#1f5f9e', bg: '#e5f2fc', card: '#eef6fc' },
    done: { fg: '#6b6a66', bg: '#f0efed', card: '#f3f2f0' },
};
const statusOf = (propRows: PagePropRow[], p: SubpageRow): Status => {
    const s = propSelect(propRows, p.id, STATUS_KEY);
    return (STATUSES as readonly string[]).includes(s ?? '') ? (s as Status) : STATUSES[0];
};

// 공통 문맥: 한 보드 블럭이 그리는 동안 필요한 것들
type Ctx = {
    dbId: string; docId: string; pages: SubpageRow[]; propRows: PagePropRow[]; users: UserRow[];
    props: RwTable<PagePropRow>; subpages: RwTable<SubpageRow>; blocks: RwTable<BlockRow>;
    openPage: (id: string) => void; navigate: (to: string) => void;
};
// 상태 변경: 속성이 있으면 값만, 없으면(속성을 지운 항목) 세 선택지와 함께 새로 만든다
function setStatus(ctx: Ctx, p: SubpageRow, status: Status) {
    const id = propId(p.id, STATUS_KEY);
    const cur = ctx.propRows.find(x => x.id === id);
    const prev = cur && typeof cur.value === 'object' && cur.value && 'options' in cur.value ? cur.value.options : [];
    const value = { value: status, options: [...new Set([...STATUSES, ...prev])] };
    group(() => (cur ? ctx.props.update({ id, value }) : ctx.props.insert({ id, doc_id: p.id, key: STATUS_KEY, type: 'select', value, pos: Math.max(0, ...ctx.propRows.filter(x => x.doc_id === p.id).map(x => x.pos)) + 1 })));
}
// 즉시 생성: 제목만 받고 나머지는 부르는 자리(상위·상태)가 정한다. ItemForm 과 같은 매크로라 한 undo 묶음이다
function createItem(ctx: Ctx, kind: ItemKind, title: string, parentId: string | null, status: Status) {
    const err = group(() => runMacro(BUILTIN_MACROS.find(m => m.id === itemMacroId(kind))!, {
        docId: ctx.docId, vars: { 제목: title, DB: ctx.dbId, 상위: parentId ?? '', 상태: status, 담당자: [], 기한: null },
        blocks: ctx.blocks, subpages: ctx.subpages, props: ctx.props, navigate: () => {},
    }));
    if (err) alert(err);
}
const onPageClick = (ctx: Ctx, id: string) => (e: MouseEvent) => {
    if (e.altKey) { e.preventDefault(); ctx.navigate(`/p/cowork/${id}`); }
    else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); ctx.openPage(id); }
};

// 상태 배지. 누르면 select 가 열려 그 자리에서 바꾼다 (select 를 배지 모양으로 그린다)
function StatusBadge({ status, onChange, small }: { status: Status; onChange?: (s: Status) => void; small?: boolean }) {
    const c = STATUS_STYLE[status];
    const cls = `inline-flex items-center rounded-full font-medium cursor-pointer appearance-none outline-none ${small ? 'h-4 px-1.5 text-[10px]' : 'h-5 px-2 text-[11px]'}`;
    if (!onChange) return <span className={cls} style={{ color: c.fg, background: c.bg }}>● {status}</span>;
    return (
        <select className={cls} style={{ color: c.fg, background: c.bg }} value={status} title="상태 바꾸기" onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value as Status)}>
            {STATUSES.map(s => <option key={s} value={s}>● {s}</option>)}
        </select>
    );
}
// 제목만 받는 즉시 생성 줄. 누르면 입력칸이 되고 Enter 로 만든다. Esc·빈 값·blur 는 접는다
function InlineAdd({ label, onCreate, indent }: { label: string; onCreate: (title: string) => void; indent?: number }) {
    const [open, setOpen] = useState(false);
    const submit = (v: string) => { const t = v.trim(); setOpen(false); if (t) onCreate(t); };
    const key = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit(e.currentTarget.value);
        if (e.key === 'Escape') setOpen(false);
    };
    return (
        <div style={{ paddingLeft: indent }}>
            {open
                ? <input autoFocus className="w-full h-7 px-2 rounded-md bg-[var(--c-bacPri)] border border-[var(--c-borPri)] outline-none text-[13px]" placeholder={`${label} 제목, Enter 로 만들기`} onKeyDown={key} onBlur={e => submit(e.target.value)} />
                : <button className="w-full text-left h-7 px-2 rounded-md text-[12px] text-[var(--c-texTer)] bg-transparent! hover:bg-[var(--ca-bacIntTra)]! hover:text-[var(--c-texPri)] cursor-pointer" onClick={() => setOpen(true)}>+ {label}</button>}
        </div>
    );
}
// 줄·카드 공통의 보조 정보: 담당자 이름 · 기한
const metaText = (ctx: Ctx, p: SubpageRow) => {
    const who = propPeople(ctx.propRows, p.id, ASSIGNEE_KEY).map(id => userName(ctx.users, id));
    const due = propTime(ctx.propRows, p.id, DUE_KEY);
    return [who.join(', '), due !== null ? fmtDate(due) : ''].filter(Boolean).join(' · ');
};
const removeItem = (ctx: Ctx, p: SubpageRow) => group(() => ctx.subpages.remove(p.id));

// ── 마일스톤 트리 ─────────────────────────────────────
// 펼침 상태는 화면에만 둔다 (동기화·undo 없음). 처음에는 마일스톤만 펼치고 작업은 접는다. 하위 집계는 "완료/전체" 이다.
const INDENT = 22;
function Tree({ ctx }: { ctx: Ctx }) {
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set()); // 작업은 기본 접힘이라 펼친 것만 기억
    const inDb = ctx.pages.filter(p => p.db_id === ctx.dbId);
    const children = (id: string, kind: ItemKind) => inDb.filter(p => p.kind === kind && p.parent_id === id).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const isOpen = (p: SubpageRow) => (p.kind === 'milestone' ? !collapsed.has(p.id) : expanded.has(p.id));
    const toggle = (p: SubpageRow) => {
        if (p.kind === 'milestone') setCollapsed(s => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
        else setExpanded(s => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
    };
    const done = (list: SubpageRow[]) => list.filter(p => statusOf(ctx.propRows, p) === 'done').length;
    const summary = (p: SubpageRow) => {
        if (p.kind === 'milestone') {
            const works = children(p.id, 'work'), tickets = works.flatMap(w => children(w.id, 'ticket'));
            return [works.length ? `작업 ${done(works)}/${works.length}` : '', tickets.length ? `티켓 ${done(tickets)}/${tickets.length}` : ''].filter(Boolean).join(' · ');
        }
        if (p.kind === 'work') { const t = children(p.id, 'ticket'); return t.length ? `티켓 ${done(t)}/${t.length}` : ''; }
        return '';
    };
    const row = (p: SubpageRow, level: number) => {
        const kind = p.kind as ItemKind;
        const childKind = ITEM_META[kind === 'milestone' ? 'work' : 'ticket'];
        const leaf = kind === 'ticket';
        const open = !leaf && isOpen(p);
        const kids = leaf ? [] : children(p.id, kind === 'milestone' ? 'work' : 'ticket');
        const s = statusOf(ctx.propRows, p);
        const info = metaText(ctx, p), sum = summary(p);
        return (
            <div key={p.id}>
                <div className="group/row flex items-center gap-2 h-8 pr-1 rounded-md hover:bg-[var(--ca-bacIntTra)]" style={{ paddingLeft: level * INDENT }}>
                    <button className={`w-5 h-5 shrink-0 text-[11px] bg-transparent! text-[var(--c-texTer)] ${leaf ? 'invisible' : 'cursor-pointer hover:text-[var(--c-texPri)]'}`} onClick={() => toggle(p)} aria-label={open ? '접기' : '펼치기'}>{open ? '▾' : '▸'}</button>
                    <Link to={`/p/cowork/${p.id}`} className="min-w-0 truncate text-[13px] cursor-pointer" title="클릭: 패널에서 열기 · Alt+클릭: 페이지로 이동" onClick={onPageClick(ctx, p.id)}>{titleOf(p)}</Link>
                    <StatusBadge status={s} onChange={st => setStatus(ctx, p, st)} small />
                    {info && <span className="shrink-0 text-[11px] text-[var(--c-texSec)] truncate max-w-40">{info}</span>}
                    {sum && <span className="shrink-0 text-[11px] text-[var(--c-texTer)]">{sum}</span>}
                    <span className="flex-1" />
                    <button className="shrink-0 opacity-0 group-hover/row:opacity-100 px-1 bg-transparent! text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer text-[12px]" title={`${ITEM_META[kind].label} 삭제 (Ctrl+Z 로 되돌릴 수 있음)`} onClick={() => removeItem(ctx, p)}>×</button>
                </div>
                {open && (
                    <>
                        {kids.map(k => row(k, level + 1))}
                        <InlineAdd label={childKind.label} indent={(level + 1) * INDENT + 20} onCreate={t => createItem(ctx, kind === 'milestone' ? 'work' : 'ticket', t, p.id, 'todo')} />
                    </>
                )}
            </div>
        );
    };
    const roots = inDb.filter(p => p.kind === 'milestone').sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    return (
        <div className="flex flex-col">
            {roots.map(m => row(m, 0))}
            <InlineAdd label="마일스톤" indent={20} onCreate={t => createItem(ctx, 'milestone', t, null, 'todo')} />
        </div>
    );
}

// ── 작업·티켓 칸반 ───────────────────────────────────
// 필터 칩: 전체 · 상위 항목별 · 상위 없음. 하나를 고르면 그 갈래만 보이고, 열 아래 즉시 생성은 그 상위로 만든다.
const NONE = '__none__';
function Kanban({ ctx, kind }: { ctx: Ctx; kind: ItemKind }) {
    const meta = ITEM_META[kind];
    const [filter, setFilter] = useState<string | null>(null); // null = 전체, NONE = 상위 없음, 그 외 = 상위 id
    const [over, setOver] = useState<Status | null>(null); // 드래그 중 카드가 위에 있는 열
    const parents = meta.parent ? ctx.pages.filter(p => p.kind === meta.parent && p.db_id === ctx.dbId).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0)) : [];
    const all = ctx.pages.filter(p => p.kind === kind && p.db_id === ctx.dbId).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const items = filter === null ? all : all.filter(p => (filter === NONE ? !ctx.pages.some(x => x.id === p.parent_id) : p.parent_id === filter));
    const drop = (e: DragEvent, status: Status) => {
        e.preventDefault(); e.stopPropagation();
        setOver(null);
        const p = items.find(x => x.id === e.dataTransfer.getData(DRAG_MIME));
        if (p && statusOf(ctx.propRows, p) !== status) setStatus(ctx, p, status);
    };
    const chip = (key: string | null, label: string) => (
        <button key={key ?? 'all'} className={`h-5 px-2 rounded-full text-[11px] cursor-pointer whitespace-nowrap ${filter === key ? 'bg-[var(--c-texPri)]! text-white' : 'bg-transparent! border border-[var(--c-borPri)] text-[var(--c-texSec)] hover:bg-[var(--ca-bacIntTra)]!'}`} onClick={() => setFilter(key)}>{label}</button>
    );
    const card = (p: SubpageRow) => {
        const parent = ctx.pages.find(x => x.id === p.parent_id);
        const s = statusOf(ctx.propRows, p);
        // 작업 카드에는 하위 티켓 집계 (완료/전체)
        const tickets = kind === 'work' ? ctx.pages.filter(x => x.kind === 'ticket' && x.parent_id === p.id) : [];
        const sum = tickets.length ? `티켓 ${tickets.filter(t => statusOf(ctx.propRows, t) === 'done').length}/${tickets.length}` : '';
        const info = [metaText(ctx, p), sum].filter(Boolean).join(' · ');
        return (
            <div
                key={p.id} draggable
                className="group/card flex flex-col gap-0.5 px-2 py-1.5 rounded-md border border-transparent cursor-grab hover:border-[var(--c-borPri)]"
                style={{ background: STATUS_STYLE[s].card }}
                onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData(DRAG_MIME, p.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setOver(null)}
            >
                <div className="flex items-start gap-1">
                    <Link to={`/p/cowork/${p.id}`} className="flex-1 min-w-0 text-[13px] leading-snug break-words cursor-pointer" title="클릭: 패널에서 열기 · Alt+클릭: 페이지로 이동" onClick={onPageClick(ctx, p.id)}>{titleOf(p)}</Link>
                    <button className="shrink-0 opacity-0 group-hover/card:opacity-100 px-1 bg-transparent! text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title={`${meta.label} 삭제 (Ctrl+Z 로 되돌릴 수 있음)`} onClick={() => removeItem(ctx, p)}>×</button>
                </div>
                {meta.parent && filter === null && <div className="truncate text-[11px] text-[var(--c-texTer)]" title={parent ? titleOf(parent) : undefined}>↑ {parent ? titleOf(parent) : p.parent_id ? '(삭제된 상위)' : '상위 없음'}</div>}
                {info && <div className="truncate text-[11px] text-[var(--c-texSec)]">{info}</div>}
            </div>
        );
    };
    return (
        <>
            {meta.parent && (
                <div className="flex flex-wrap items-center gap-1">
                    {chip(null, '전체')}
                    {parents.map(p => chip(p.id, titleOf(p)))}
                    {chip(NONE, '상위 없음')}
                </div>
            )}
            <div className="grid grid-cols-3 gap-2">
                {STATUSES.map(status => {
                    const col = items.filter(p => statusOf(ctx.propRows, p) === status);
                    return (
                        <div
                            key={status}
                            className={`flex flex-col gap-1.5 p-1.5 rounded-md bg-[var(--c-bacSec)] min-h-24 ${over === status ? 'ring-2 ring-[var(--c-bluBacAccPri)]/50' : ''}`}
                            onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setOver(status); } }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(o => (o === status ? null : o)); }}
                            onDrop={e => drop(e, status)}
                        >
                            <div className="flex items-center gap-1.5 px-1"><StatusBadge status={status} /><span className="text-[11px] text-[var(--c-texTer)]">{col.length}</span></div>
                            {col.map(card)}
                            <InlineAdd label={`새 ${meta.label}`} onCreate={t => createItem(ctx, kind, t, filter && filter !== NONE ? filter : null, status)} />
                        </div>
                    );
                })}
            </div>
        </>
    );
}

export function ItemBoard({ r, kind, pages, propRows, props, subpages, openPage, navigate, onSettings, onNew }: {
    r: BlockRow; kind: ItemKind; pages: SubpageRow[]; propRows: PagePropRow[]; props: RwTable<PagePropRow>; subpages: RwTable<SubpageRow>;
    openPage: (id: string) => void; navigate: (to: string) => void; onSettings: () => void; onNew: () => void;
}) {
    const meta = ITEM_META[kind];
    const dbs = table<DbRow>('dbs', 'ro').useRows();
    const blocks = table<BlockRow>('blocks', 'rw');
    const users = useUsers();
    const ctx: Ctx = { dbId: r.ref ?? '', docId: r.doc_id, pages, propRows, users, props, subpages, blocks, openPage, navigate };
    return (
        <div className="rounded-md border border-[var(--c-borPri)] p-3 flex flex-col gap-3 select-none" onDragOver={e => e.stopPropagation()} onDrop={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-[15px] font-medium">{meta.label} <span className="text-[13px] font-normal text-[var(--c-texTer)]">· {dbName(dbs, r.ref)}</span></span>
                <button className="h-7 w-7 rounded-md text-[15px] cursor-pointer bg-transparent! text-[var(--c-texTer)] hover:bg-[var(--ca-bacIntTra)]! hover:text-[var(--c-texPri)]" title="보드 설정" aria-label="보드 설정" onClick={onSettings}>⚙</button>
                <button className="h-7 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95 whitespace-nowrap" onClick={onNew}>+ 새 {meta.label}</button>
            </div>
            {kind === 'milestone' ? <Tree ctx={ctx} /> : <Kanban ctx={ctx} kind={kind} />}
        </div>
    );
}
