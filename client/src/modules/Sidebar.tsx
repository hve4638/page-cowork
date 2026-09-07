// 왼쪽 사이드바. Workspace 본문 열의 왼쪽에 붙어 페이지 목록(평면, pos 순)과 내 최근 편집 페이지를 보여준다.
// 접힘 상태는 zustand 스토어에 두고 localStorage 에 기억한다 — 접힌 동안의 펼침 버튼은 탑바(App)에 있어 두 자리가 공유한다.
// 좁은 폭(768px 이하)에서는 기억한 값과 무관하게 접힌 채 시작하고, 펼치면 본문을 밀지 않고 왼쪽 오버레이로 뜬다
// (항목 선택·바깥 클릭으로 닫힘). 오버레이 z-40 은 SidePeek 의 모바일 오버레이와 같은 층이라 동시에 열리지 않는다.
// 최근 편집은 서버가 편집 mutation 마다 찍는 recent_edits 행(읽기 전용)을 내 user_id 로 걸러 최신순으로 보인다.
// 회의 목록은 subpages 의 kind='meeting' 행(삭제 표시 없는 것)을 속성 '일시' 최신순으로 보이는 뷰다. 회의의 생성·삭제는 여기서 하지 않는다 —
// 회의록은 홈의 회의 보드 블럭('/회의') 안에서 만들고 지운다 (사용자 결정 2026-09-07).
// 하단에는 매크로·템플릿 섹션(접기 가능, 헤더의 + 로 새로 만들기, 목록 끝의 접힌 "내장" 항목)과 관리 페이지 링크(admin)를 둔다 (macro-template 2026-09-07).
// 템플릿은 kind='template' 인 서브페이지라 클릭하면 그 페이지로 가고, 매크로는 오른쪽 패널의 편집기(MacroEditor)를 연다.
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { create } from 'zustand';
import type { RoTable, RwTable } from '@/sync/handle';
import { rid } from '@/sync/store';
import type { Me } from '@/auth/api';
import { pageTitle, type BlockRow, type SubpageRow } from './BlockDoc';
import { fmtDate, propTime, type PagePropRow } from './props';
import { BUILTIN_MACROS, type MacroRow } from './macros';
import { duplicateTemplate, MEETING_TEMPLATE_ID, templatePages } from './templates';
import { useSidePeek } from './SidePeek';

export type RecentEditRow = {
    id: string; // '<user_id>:<doc_id>'
    user_id: string;
    doc_id: string; // subpages.id 또는 'home'
    updated_at: number;
};

const narrowQuery = matchMedia('(max-width: 768px)');
const useNarrow = () => useSyncExternalStore(
    fn => { narrowQuery.addEventListener('change', fn); return () => narrowQuery.removeEventListener('change', fn); },
    () => narrowQuery.matches,
);

const STORAGE_KEY = 'sidebar.collapsed';
export const useSidebar = create<{ open: boolean; toggle: () => void; close: () => void }>(set => ({
    open: !narrowQuery.matches && localStorage.getItem(STORAGE_KEY) !== '1',
    toggle: () => set(s => {
        if (!narrowQuery.matches) localStorage.setItem(STORAGE_KEY, s.open ? '1' : '0'); // 좁은 폭의 열림은 일시적이라 기억하지 않는다
        return { open: !s.open };
    }),
    close: () => set({ open: false }),
}));
narrowQuery.addEventListener('change', e => { if (e.matches) useSidebar.getState().close(); });

const HOME_TO = '/p/cowork';
const RECENT_LIMIT = 10;

// meta 는 오른쪽에 붙는 보조 표시(회의 날짜)
function PageLink({ to, label, meta, current, onPick }: { to: string; label: string; meta?: string; current: boolean; onPick: () => void }) {
    return (
        <Link
            to={to}
            title={label}
            onClick={onPick}
            className={`flex items-center gap-1 px-2 py-2.5 md:py-1 rounded-md text-[14px] hover:bg-[var(--ca-bacIntTra)] ${
                current ? 'bg-[var(--ca-bacIntTra)] font-medium text-[var(--c-texPri)]' : 'text-[var(--c-texSec)]'
            }`}
        >
            <span className="flex-1 truncate">{label}</span>
            {meta && <span className="shrink-0 text-[12px] text-[var(--c-texTer)]">{meta}</span>}
        </Link>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="px-2 pt-3">
            <div className="px-2 pb-1 text-[12px] font-medium text-[var(--c-texTer)]">{title}</div>
            {children}
        </section>
    );
}

// 접을 수 있는 섹션 (매크로·템플릿). 접힘은 localStorage 에 기억한다. 헤더 오른쪽 끝의 + 가 onAdd.
function FoldSection({ id, title, onAdd, children }: { id: string; title: string; onAdd: () => void; children: ReactNode }) {
    const key = `sidebar.fold.${id}`;
    const [open, setOpen] = useState(() => localStorage.getItem(key) !== '1');
    const toggle = () => { localStorage.setItem(key, open ? '1' : '0'); setOpen(!open); };
    return (
        <section className="px-2 pt-3">
            <div className="group/sec flex items-center px-2 pb-1 text-[12px] font-medium text-[var(--c-texTer)]">
                <button className="flex-1 flex items-center gap-1 text-left cursor-pointer bg-transparent! hover:text-[var(--c-texSec)]" onClick={toggle}>
                    <span className="inline-block w-3">{open ? '▾' : '▸'}</span>{title}
                </button>
                <button className="px-1.5 rounded-md cursor-pointer bg-transparent! opacity-0 group-hover/sec:opacity-100 hover:bg-[var(--ca-bacIntTra)]! hover:text-[var(--c-texPri)]" onClick={onAdd} title={`새 ${title}`} aria-label={`새 ${title}`}>+</button>
            </div>
            {open && children}
        </section>
    );
}
// 목록 끝의 접힌 "내장" 항목. 누르면 내장으로 쓰는 것들이 펼쳐진다 (화면 상태, 기억하지 않는다)
function BuiltinFold({ title, children }: { title: string; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <button className="w-full flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-[var(--c-texTer)] cursor-pointer bg-transparent! hover:bg-[var(--ca-bacIntTra)]!" onClick={() => setOpen(!open)}>
                <span className="inline-block w-3">{open ? '▾' : '▸'}</span>{title}
            </button>
            {open && <div className="pl-3">{children}</div>}
        </>
    );
}
// 매크로·템플릿 항목: 아이콘 + 이름, 호버 시 오른쪽에 × (onRemove 가 있을 때만)
function Item({ icon, label, current, onClick, onCopy, onRemove }: { icon: string; label: string; current?: boolean; onClick: () => void; onCopy?: () => void; onRemove?: () => void }) {
    return (
        <div className={`group/item flex items-center gap-1 pr-1 rounded-md text-[14px] hover:bg-[var(--ca-bacIntTra)] ${current ? 'bg-[var(--ca-bacIntTra)] font-medium text-[var(--c-texPri)]' : 'text-[var(--c-texSec)]'}`}>
            <button className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-2.5 md:py-1 text-left cursor-pointer bg-transparent!" onClick={onClick} title={label}>
                <span className="shrink-0 w-5 text-center">{icon}</span><span className="truncate">{label}</span>
            </button>
            {onCopy && <button className="shrink-0 px-1 bg-transparent! opacity-0 group-hover/item:opacity-100 text-[12px] text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="복제" onClick={onCopy}>⧉</button>}
            {onRemove && <button className="shrink-0 px-1 bg-transparent! opacity-0 group-hover/item:opacity-100 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="삭제" onClick={onRemove}>×</button>}
        </div>
    );
}

export function Sidebar({ me, subpages, recents, props, macros, blocks }: { me: Me; subpages: RwTable<SubpageRow>; recents: RoTable<RecentEditRow>; props: RwTable<PagePropRow>; macros: RwTable<MacroRow>; blocks: RwTable<BlockRow> }) {
    const { open, toggle, close } = useSidebar();
    const narrow = useNarrow();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const openMacro = useSidePeek(s => s.openMacro);
    const peekItem = useSidePeek(s => s.item);
    const pages = subpages.useRows().filter(p => !p.deleted_at);
    const recentRows = recents.useRows();
    const propRows = props.useRows();
    const macroRows = macros.useRows();
    if (!open) return null;

    const byId = new Map(pages.map(p => [p.id, p]));
    // 홈은 subpages 에 id='home' 행으로 있을 수 있다 (home-layout-editable 이후). 있으면 그 제목을 쓰고, 목록에서는 별도 항목이라 거른다
    const home = { to: HOME_TO, label: byId.get('home')?.title || 'cowork' };
    const linkOf = (docId: string) =>
        docId === 'home' ? home : { to: `/p/cowork/${docId}`, label: pageTitle(byId.get(docId)) };
    // 삭제된 페이지의 기록은 서버가 연쇄 삭제하지만, 도착 순서 사이의 찰나를 대비해 없는 페이지는 건너뛴다
    const recent = recentRows
        .filter(r => r.user_id === me.id && (r.doc_id === 'home' || byId.has(r.doc_id)))
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, RECENT_LIMIT);
    const sorted = pages.filter(p => p.id !== 'home' && !p.kind).sort((a, b) => a.pos - b.pos); // 회의록·템플릿은 각자 섹션에
    const heldAt = (p: SubpageRow) => propTime(propRows, p.id, '일시') ?? p.created_at ?? 0;
    const meetings = pages.filter(p => p.kind === 'meeting').sort((a, b) => heldAt(b) - heldAt(a));

    const onPick = () => { if (narrow) close(); };

    // 매크로·템플릿 (사용자 것은 만든 순, 내장은 목록 끝의 접힌 항목 안). 내장 '/' 명령(페이지·표 등 원자적 동작)은 매크로가 아니라서 보이지 않는다
    const userMacros = [...macroRows].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
    const builtinMacros = BUILTIN_MACROS;
    const templates = templatePages(pages);
    const addMacro = () => {
        const m: MacroRow = { id: rid(8), name: '새 매크로', icon: '⚡', keywords: [], inputs: [], steps: [] };
        if (macros.insert(m)) { openMacro(m.id); onPick(); }
    };
    const removeMacro = (m: MacroRow) => { if (confirm(`매크로 '${m.name}' 을 지울까요?`)) macros.remove(m.id); };
    const addTemplate = () => {
        const t: SubpageRow = { id: rid(16), title: '새 템플릿', pos: Math.max(0, ...pages.map(p => p.pos)) + 1, kind: 'template' };
        if (subpages.insert(t)) { navigate(`/p/cowork/${t.id}`); onPick(); }
    };
    // 템플릿 삭제는 서버가 본문·속성까지 지운다 (되돌릴 수 없다)
    const removeTemplate = (t: SubpageRow) => { if (confirm(`템플릿 '${pageTitle(t)}' 을 지울까요? 되돌릴 수 없습니다.`)) subpages.remove(t.id); };
    const macroItem = (m: MacroRow, removable: boolean) => (
        <Item key={m.id} icon={m.icon || '⚡'} label={m.name || '이름 없음'} current={peekItem?.kind === 'macro' && peekItem.id === m.id}
            onClick={() => { openMacro(m.id); onPick(); }} onRemove={removable ? () => removeMacro(m) : undefined} />
    );
    // 복제: 사본 페이지·본문·속성을 만들고 그 페이지로 간다. 내장 회의록도 복제해 고칠 수 있다
    const copyTemplate = (t: SubpageRow) => {
        const d = duplicateTemplate(t, pages);
        if (!subpages.insert(d.page)) return;
        d.blocks.forEach(b => blocks.insert(b));
        d.props.forEach(p => props.insert(p));
        navigate(`/p/cowork/${d.page.id}`); onPick();
    };
    const templateItem = (t: SubpageRow) => {
        const to = `/p/cowork/${t.id}`;
        return <Item key={t.id} icon="📋" label={pageTitle(t)} current={pathname === to} onClick={() => { navigate(to); onPick(); }} onCopy={() => copyTemplate(t)} onRemove={t.id === MEETING_TEMPLATE_ID ? undefined : () => removeTemplate(t)} />;
    };
    const userTemplates = templates.filter(t => t.id !== MEETING_TEMPLATE_ID), builtinTemplates = templates.filter(t => t.id === MEETING_TEMPLATE_ID);

    return (
        <>
        {narrow && <div className="fixed inset-0 z-30 bg-black/20" onClick={close} />}
        <aside className={`w-60 shrink-0 h-full flex flex-col border-r border-[var(--c-borPri)] bg-[var(--c-bacSec)] text-sm ${
            narrow ? 'fixed inset-y-0 left-0 z-40 shadow-lg' : ''
        }`}>
            {/* 탑바와 같은 44px 높이 */}
            <header className="h-11 shrink-0 flex items-center gap-1 px-3">
                <span className="flex-1 font-medium truncate">cowork</span>
                <button className="px-2 py-1 rounded-md cursor-pointer text-[var(--c-texSec)] hover:bg-[var(--ca-bacIntTra)]" onClick={toggle} aria-label="사이드바 접기" title="사이드바 접기">
                    «
                </button>
            </header>
            <div className="flex-1 overflow-y-auto pb-4">
                {recent.length > 0 && (
                    <Section title="최근 편집">
                        {recent.map(r => {
                            const l = linkOf(r.doc_id);
                            return <PageLink key={r.id} to={l.to} label={l.label} current={pathname === l.to} onPick={onPick} />;
                        })}
                    </Section>
                )}
                <Section title="페이지">
                    <PageLink to={home.to} label={home.label} current={pathname === home.to} onPick={onPick} />
                    {sorted.map(p => {
                        const to = `/p/cowork/${p.id}`;
                        return <PageLink key={p.id} to={to} label={pageTitle(p)} current={pathname === to} onPick={onPick} />;
                    })}
                </Section>
                {meetings.length > 0 && (
                    <Section title="회의">
                        {meetings.map(p => {
                            const to = `/p/cowork/${p.id}`;
                            return <PageLink key={p.id} to={to} label={pageTitle(p)} meta={fmtDate(heldAt(p))} current={pathname === to} onPick={onPick} />;
                        })}
                    </Section>
                )}
                <FoldSection id="macros" title="매크로" onAdd={addMacro}>
                    {userMacros.map(m => macroItem(m, true))}
                    <BuiltinFold title={`내장 매크로 (${builtinMacros.length})`}>{builtinMacros.map(m => macroItem(m, false))}</BuiltinFold>
                </FoldSection>
                <FoldSection id="templates" title="템플릿" onAdd={addTemplate}>
                    {userTemplates.map(templateItem)}
                    <BuiltinFold title={`내장 템플릿 (${builtinTemplates.length})`}>{builtinTemplates.map(templateItem)}</BuiltinFold>
                </FoldSection>
            </div>
            {me.role === 'admin' && (
                <footer className="shrink-0 border-t border-[var(--c-borPri)] p-2">
                    <PageLink to="/admin" label="관리 페이지" current={pathname === '/admin'} onPick={onPick} />
                </footer>
            )}
        </aside>
        </>
    );
}

// 접힌 상태에서 탑바 왼쪽에 놓는 펼침 버튼
export function SidebarToggle() {
    const { open, toggle } = useSidebar();
    if (open) return null;
    return (
        <button className="px-2 py-1 rounded-md cursor-pointer text-[var(--c-texSec)] hover:bg-[var(--ca-bacIntTra)]" onClick={toggle} aria-label="사이드바 펼치기" title="사이드바 펼치기">
            »
        </button>
    );
}
