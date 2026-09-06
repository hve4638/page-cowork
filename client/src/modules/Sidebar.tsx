// 왼쪽 사이드바. Workspace 본문 열의 왼쪽에 붙어 페이지 목록(평면, pos 순)과 내 최근 편집 페이지를 보여준다.
// 접힘 상태는 zustand 스토어에 두고 localStorage 에 기억한다 — 접힌 동안의 펼침 버튼은 탑바(App)에 있어 두 자리가 공유한다.
// 좁은 폭(768px 이하)에서는 기억한 값과 무관하게 접힌 채 시작하고, 펼치면 본문을 밀지 않고 왼쪽 오버레이로 뜬다
// (항목 선택·바깥 클릭으로 닫힘). 오버레이 z-40 은 SidePeek 의 모바일 오버레이와 같은 층이라 동시에 열리지 않는다.
// 최근 편집은 서버가 편집 mutation 마다 찍는 recent_edits 행(읽기 전용)을 내 user_id 로 걸러 최신순으로 보인다.
// 회의 목록은 subpages 의 kind='meeting' 행(삭제 표시 없는 것)을 속성 '일시' 최신순으로 보이는 뷰다. 회의의 생성·삭제는 여기서 하지 않는다 —
// 회의록은 홈의 회의 보드 블럭('/회의') 안에서 만들고 지운다 (사용자 결정 2026-09-07).
// 하단에는 관리 페이지 링크(admin)를 둔다 — 홈 본문의 고정 링크가 사이드바와 겹치던 것을 옮겼다.
import { useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { create } from 'zustand';
import type { RoTable } from '@/sync/handle';
import type { Me } from '@/auth/api';
import { pageTitle, type SubpageRow } from './BlockDoc';
import { fmtDate, propTime, type PagePropRow } from './props';

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

export function Sidebar({ me, subpages, recents, props }: { me: Me; subpages: RoTable<SubpageRow>; recents: RoTable<RecentEditRow>; props: RoTable<PagePropRow> }) {
    const { open, toggle, close } = useSidebar();
    const narrow = useNarrow();
    const { pathname } = useLocation();
    const pages = subpages.useRows().filter(p => !p.deleted_at);
    const recentRows = recents.useRows();
    const propRows = props.useRows();
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
    const sorted = pages.filter(p => p.id !== 'home' && p.kind !== 'meeting').sort((a, b) => a.pos - b.pos);
    const heldAt = (p: SubpageRow) => propTime(propRows, p.id, '일시') ?? p.created_at ?? 0;
    const meetings = pages.filter(p => p.kind === 'meeting').sort((a, b) => heldAt(b) - heldAt(a));

    const onPick = () => { if (narrow) close(); };

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
