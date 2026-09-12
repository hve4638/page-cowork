// 왼쪽 사이드바. Workspace 본문 열의 왼쪽에 붙어 페이지 목록(평면, pos 순)·매크로·템플릿·변경사항을 보여준다.
// 접힘 상태는 zustand 스토어에 두고 localStorage 에 기억한다 — 접힌 동안의 펼침 버튼은 탑바(App)에 있어 두 자리가 공유한다.
// 좁은 폭(768px 이하)에서는 기억한 값과 무관하게 접힌 채 시작하고, 펼치면 본문을 밀지 않고 왼쪽 오버레이로 뜬다
// (항목 선택·바깥 클릭으로 닫힘). 오버레이 z-40 은 SidePeek 의 모바일 오버레이와 같은 층이라 동시에 열리지 않는다.
// 순서는 페이지 → 매크로 → 템플릿 → 내 변경사항 → 변경사항 (사용자 결정 2026-09-08 undo-model). 회의록은 따로 섹션을 두지 않고 페이지 목록에 보통 페이지처럼 들어간다.
// 이전의 "최근 편집"(recent_edits)·"회의" 섹션은 이때 없앴다.
// 섹션은 VS Code 사이드바처럼 접이식 구획(Panes)이다: 헤더는 항상 보이고(접힌 구획은 헤더만 남아 쌓인다), 펼친 구획은 각자 영역과 스크롤을 가지며
// 사이드바 전체가 스크롤되지 않는다. 펼친 구획 사이의 경계를 끌어 크기를 조절하고, 접힘·크기는 localStorage 에 기억한다 (사용자 결정 2026-09-08).
// 매크로·템플릿 헤더의 + 로 새로 만들며 목록 끝에 접힌 "내장" 항목이 있다 (macro-template 2026-09-07).
// 템플릿은 kind='template' 인 서브페이지라 클릭하면 그 페이지로 가고, 매크로는 오른쪽 패널의 편집기(MacroEditor)를 연다.
// 내 변경사항은 이 브라우저의 undo 스택(sync/history.ts, 내가 이번 세션에 보낸 묶음)이고, 변경사항은 서버 changes 로그의 묶음 요약(change_groups, 모든 사용자, 최근 50개 + 실시간)이다.
// 둘 다 보기 전용이다. 되돌리기는 Ctrl+Z 로만 한다 (사용자 결정 2026-09-08).
// 버전은 changes 로그의 한 지점에 이름을 붙인 것이다 (version-snapshot 2026-09-09). 헤더의 + 로 현재 시점을 이름 붙여 두고, 항목의 ↺ 로 그 시점으로
// 되돌아간다 — 되돌아가기는 버전 이후의 변경을 전부 되감은 묶음 하나로 이력 위에 얹히고(git revert), 내 변경사항에 올라 Ctrl+Z 로 다시 되감을 수 있다.
// 자정 기준 자동 버전(직전 자동 버전 이후 묶음 10건 이상)은 서버가 만든다. 워크스페이스 전체 단위다 (사용자 결정 2026-09-09).
import { useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { create } from 'zustand';
import type { RoTable, RwTable } from '@/sync/handle';
import { rid, sendVersion } from '@/sync/store';
import { group, restoreVersion, useHistory } from '@/sync/history';
import type { Me } from '@/auth/api';
import { pageTitle, type BlockRow, type SubpageRow } from './BlockDoc';
import type { PagePropRow } from './props';
import { BUILTIN_MACROS, type MacroRow } from './macros';
import { duplicateTemplate, MEETING_TEMPLATE_ID, templatePages } from './templates';
import { useSidePeek } from './SidePeek';
import { isItemKind } from './itemKinds';

// 서버 changes 로그의 묶음 요약 (읽기 전용 change_groups). 사용자 조작 하나 = 묶음 하나.
export type ChangeGroupRow = {
    id: string; // group_id
    user_id: string | null;
    user_name: string | null; // 닉네임. 서버 자체(GC)면 null
    ts: number; // 마지막 변경 시각
    first_ts: number;
    inserts: number; updates: number; deletes: number;
    tables: string[];
    doc_ids: string[]; // 건드린 문서 (subpages.id 또는 'home')
    reverts: string | null; // 되감기 묶음이면 원래 묶음 id. 버전 복원 묶음이면 'version:<버전 id>'
};
// 버전(스냅샷). 읽기 전용 versions — 행은 서버가 만든다 (수동: WS 'version', 자동: 자정 기준)
export type VersionRow = {
    id: string;
    name: string;
    ts: number; // 버전이 가리키는 시점
    change_id: number; // 그 시점의 마지막 changes.id
    auto: number; // 1 이면 서버가 만든 자동 버전
    created_by: string | null;
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
const GROUP_LIMIT = 50;

// 변경 시각을 짧게: 방금 · n분 전 · n시간 전 · 어제 · M/D
function fmtAgo(ts: number, now: number): string {
    const d = now - ts;
    if (d < 60_000) return '방금';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}분 전`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}시간 전`;
    if (d < 2 * 86_400_000) return '어제';
    const t = new Date(ts);
    return `${t.getMonth() + 1}/${t.getDate()}`;
}
// 묶음 한 줄: "삽입 n · 수정 n · 삭제 n" 중 0 이 아닌 것. 되감기면 앞에 "되돌림"
function describe(g: ChangeGroupRow): string {
    const parts = [g.reverts && (g.reverts.startsWith('version:') ? '버전 복원' : '되돌림'), g.inserts && `삽입 ${g.inserts}`, g.updates && `수정 ${g.updates}`, g.deletes && `삭제 ${g.deletes}`].filter(Boolean);
    return parts.join(' · ') || '변경';
}
// 문서가 없는 묶음(녹음 상태·매크로·파일)의 자리 이름
const TABLE_LABEL: Record<string, string> = { recordings: '녹음', recording_marks: '녹음 메모', macros: '매크로', files: '파일', subpages: '페이지' };
// 변경사항 항목 (보기 전용). 위 줄: 문서 · 무엇을, 아래 줄: 누가 · 언제. dim 은 redo 대기 중인 항목(undo 된 것)
function GroupItem({ g, docLabel, now, dim, mine }: { g: ChangeGroupRow; docLabel: (id: string) => string; now: number; dim?: boolean; mine?: boolean }) {
    const docs = g.doc_ids.map(docLabel).filter(Boolean);
    const where = docs.length ? docs.slice(0, 2).join(', ') + (docs.length > 2 ? ` 외 ${docs.length - 2}` : '') : g.tables.map(t => TABLE_LABEL[t]).find(Boolean) ?? '';
    return (
        <div className={`px-2 py-1 rounded-md text-[12px] leading-snug ${dim ? 'opacity-40' : ''}`} title={`${g.user_name ?? '서버'} · ${new Date(g.ts).toLocaleString()}`}>
            <div className="truncate text-[var(--c-texSec)]"><span className="text-[var(--c-texPri)]">{where || '—'}</span> · {describe(g)}</div>
            {!mine && <div className="truncate text-[var(--c-texTer)]">{g.user_name ?? '서버'} · {fmtAgo(g.ts, now)}</div>}
            {mine && <div className="truncate text-[var(--c-texTer)]">{fmtAgo(g.ts, now)}</div>}
        </div>
    );
}

// 버전 항목: 이름 · 시각, 호버 시 ↺(되돌아가기). 자동 버전은 🕒, 수동은 🔖
function VersionItem({ v, now, onRestore }: { v: VersionRow; now: number; onRestore: () => void }) {
    return (
        <div className="group/item flex items-center gap-1 pr-1 rounded-md text-[12px] hover:bg-[var(--ca-bacIntTra)]" title={`${v.name} · ${new Date(v.ts).toLocaleString()}`}>
            <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1">
                <span className="shrink-0 w-5 text-center">{v.auto ? '🕒' : '🔖'}</span>
                <span className="truncate text-[var(--c-texPri)]">{v.name}</span>
                <span className="shrink-0 text-[var(--c-texTer)]">{fmtAgo(v.ts, now)}</span>
            </div>
            <button className="shrink-0 px-1 bg-transparent! opacity-0 group-hover/item:opacity-100 text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="이 버전으로 되돌아가기" onClick={onRestore}>↺</button>
        </div>
    );
}

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

// 접이식 구획 묶음. 펼친 구획은 flex 비중(weight)으로 높이를 나누고, 경계 드래그는 위·아래 두 펼친 구획의 비중을 픽셀 차이만큼 주고받는다 (합은 불변).
type PaneDef = { id: string; title: string; onAdd?: () => void; children: ReactNode };
const PANE_MIN = 48; // 펼친 구획 본문의 최소 높이(px)
const load = <T,>(key: string, fallback: T): T => { try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; } };
function Panes({ panes }: { panes: PaneDef[] }) {
    const [open, setOpen] = useState<Record<string, boolean>>(() => load('sidebar.panes.open', {}));
    const [weight, setWeight] = useState<Record<string, number>>(() => load('sidebar.panes.weight', {}));
    const bodies = useRef(new Map<string, HTMLDivElement>());
    const isOpen = (id: string) => open[id] !== false;
    const openIds = panes.filter(p => isOpen(p.id)).map(p => p.id);
    const toggle = (id: string) => { const next = { ...open, [id]: !isOpen(id) }; setOpen(next); localStorage.setItem('sidebar.panes.open', JSON.stringify(next)); };
    // below 구획의 위 경계를 끈다: 바로 위의 펼친 구획과 높이를 주고받는다
    const startDrag = (e: ReactPointerEvent<HTMLDivElement>, below: string) => {
        const above = openIds[openIds.indexOf(below) - 1];
        const a = bodies.current.get(above), b = bodies.current.get(below);
        if (!above || !a || !b) return;
        e.preventDefault();
        const hA = a.offsetHeight, hB = b.offsetHeight, y0 = e.clientY, wA = weight[above] ?? 1, wB = weight[below] ?? 1;
        let next = weight;
        const move = (ev: PointerEvent) => {
            const dy = Math.max(-(hA - PANE_MIN), Math.min(hB - PANE_MIN, ev.clientY - y0));
            const nA = ((hA + dy) / (hA + hB)) * (wA + wB);
            next = { ...weight, [above]: nA, [below]: wA + wB - nA };
            setWeight(next);
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); localStorage.setItem('sidebar.panes.weight', JSON.stringify(next)); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    };
    return (
        <div className="flex-1 min-h-0 flex flex-col">
            {panes.map(p => {
                const o = isOpen(p.id), first = openIds[0] === p.id;
                return (
                    <section key={p.id} className="relative flex flex-col border-t border-[var(--c-borPri)] first:border-t-0" style={o ? { flex: `${weight[p.id] ?? 1} 1 0px`, minHeight: PANE_MIN + 28 } : { flex: '0 0 auto' }}>
                        {o && !first && <div className="absolute -top-[3px] left-0 right-0 h-[6px] z-10 cursor-row-resize hover:bg-[var(--c-bluBacAccPri)]/40" onPointerDown={e => startDrag(e, p.id)} />}
                        <div className="group/sec shrink-0 flex items-center px-4 h-7 text-[12px] font-medium text-[var(--c-texTer)] select-none">
                            <button className="flex-1 flex items-center gap-1 text-left cursor-pointer bg-transparent! hover:text-[var(--c-texSec)]" onClick={() => toggle(p.id)}>
                                <span className="inline-block w-3">{o ? '▾' : '▸'}</span>{p.title}
                            </button>
                            {p.onAdd && <button className="px-1.5 rounded-md cursor-pointer bg-transparent! opacity-0 group-hover/sec:opacity-100 hover:bg-[var(--ca-bacIntTra)]! hover:text-[var(--c-texPri)]" onClick={p.onAdd} title={`새 ${p.title}`} aria-label={`새 ${p.title}`}>+</button>}
                        </div>
                        {o && <div ref={el => { if (el) bodies.current.set(p.id, el); else bodies.current.delete(p.id); }} className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">{p.children}</div>}
                    </section>
                );
            })}
        </div>
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

export function Sidebar({ me, subpages, props, macros, blocks, groups, versions }: { me: Me; subpages: RwTable<SubpageRow>; props: RwTable<PagePropRow>; macros: RwTable<MacroRow>; blocks: RwTable<BlockRow>; groups: RoTable<ChangeGroupRow>; versions: RoTable<VersionRow> }) {
    const { open, toggle, close } = useSidebar();
    const narrow = useNarrow();
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const openMacro = useSidePeek(s => s.openMacro);
    const peekItem = useSidePeek(s => s.item);
    const pages = subpages.useRows();
    const macroRows = macros.useRows();
    const groupRows = groups.useRows();
    const versionRows = versions.useRows();
    const hist = useHistory();
    const now = Date.now(); // 렌더 시각 기준의 상대 시각. 새 변경이 오면 다시 그려진다
    if (!open) return null;

    const byId = new Map(pages.map(p => [p.id, p]));
    // 홈은 subpages 에 id='home' 행으로 있을 수 있다 (home-layout-editable 이후). 있으면 그 제목을 쓰고, 목록에서는 별도 항목이라 거른다
    const home = { to: HOME_TO, label: byId.get('home')?.title || 'cowork' };
    const docLabel = (docId: string) => (docId === 'home' ? home.label : pageTitle(byId.get(docId)));
    const sorted = pages.filter(p => p.id !== 'home' && p.kind !== 'template' && !isItemKind(p.kind)).sort((a, b) => a.pos - b.pos); // 템플릿은 자기 섹션에, 항목은 보드에만, 회의록은 보통 페이지처럼
    // 변경사항: 서버 요약 최신순. 내 변경사항: undo 스택 순(최근이 위), redo 대기(undo 된 것)는 흐리게 그 위에
    const byGroup = new Map(groupRows.map(g => [g.id, g]));
    const global = [...groupRows].sort((a, b) => b.ts - a.ts).slice(0, GROUP_LIMIT);
    // 스택의 항목이 되감기 묶음(undo→redo 를 거친 것)이면 원래 조작을 보인다 — 사용자에게는 "그 조작이 다시 살아 있다" 는 뜻이므로
    const origin = (id: string) => { let g = byGroup.get(id); for (let i = 0; g?.reverts && i < 50; i++) g = byGroup.get(g.reverts) ?? g; return g; };
    const mineUndo = [...hist.undo].reverse().map(origin).filter((g): g is ChangeGroupRow => !!g);
    const mineRedo = [...hist.redo].reverse().map(origin).filter((g): g is ChangeGroupRow => !!g);

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
    const removeTemplate = (t: SubpageRow) => { if (confirm(`템플릿 '${pageTitle(t)}' 을 지울까요? (Ctrl+Z 로 되돌릴 수 있습니다)`)) subpages.remove(t.id); };
    const macroItem = (m: MacroRow, removable: boolean) => (
        <Item key={m.id} icon={m.icon || '⚡'} label={m.name || '이름 없음'} current={peekItem?.kind === 'macro' && peekItem.id === m.id}
            onClick={() => { openMacro(m.id); onPick(); }} onRemove={removable ? () => removeMacro(m) : undefined} />
    );
    // 복제: 사본 페이지·본문·속성을 만들고 그 페이지로 간다. 내장 회의록도 복제해 고칠 수 있다
    const copyTemplate = (t: SubpageRow) => {
        const d = duplicateTemplate(t, pages);
        if (!group(() => { if (!subpages.insert(d.page)) return false; d.blocks.forEach(b => blocks.insert(b)); d.props.forEach(p => props.insert(p)); return true; })) return; // 한 undo 묶음
        navigate(`/p/cowork/${d.page.id}`); onPick();
    };
    const templateItem = (t: SubpageRow) => {
        const to = `/p/cowork/${t.id}`;
        return <Item key={t.id} icon="📋" label={pageTitle(t)} current={pathname === to} onClick={() => { navigate(to); onPick(); }} onCopy={() => copyTemplate(t)} onRemove={t.id === MEETING_TEMPLATE_ID ? undefined : () => removeTemplate(t)} />;
    };
    const userTemplates = templates.filter(t => t.id !== MEETING_TEMPLATE_ID), builtinTemplates = templates.filter(t => t.id === MEETING_TEMPLATE_ID);

    // 버전: 최신이 위. 지정은 이름을 물어 서버에 보내고, 되돌아가기는 확인 뒤 버전 이후 변경 전부를 되감는다 (다른 사람 것도 포함되므로 확인한다)
    const versionList = [...versionRows].sort((a, b) => b.ts - a.ts);
    const addVersion = () => {
        const name = prompt('이 시점의 버전 이름', new Date().toLocaleString())?.trim();
        if (name) sendVersion(name);
    };
    const restore = (v: VersionRow) => {
        if (confirm(`'${v.name}' 시점으로 되돌아갈까요? 그 이후의 모든 변경(다른 사람 것 포함)이 되돌려집니다. Ctrl+Z 로 다시 되감을 수 있습니다.`)) restoreVersion(v.id);
    };

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
            <Panes panes={[
                { id: 'pages', title: '페이지', children: (
                    <>
                        <PageLink to={home.to} label={home.label} current={pathname === home.to} onPick={onPick} />
                        {sorted.map(p => {
                            const to = `/p/cowork/${p.id}`;
                            return <PageLink key={p.id} to={to} label={pageTitle(p)} current={pathname === to} onPick={onPick} />;
                        })}
                    </>
                ) },
                { id: 'macros', title: '매크로', onAdd: addMacro, children: (
                    <>
                        {userMacros.map(m => macroItem(m, true))}
                        <BuiltinFold title={`내장 매크로 (${builtinMacros.length})`}>{builtinMacros.map(m => macroItem(m, false))}</BuiltinFold>
                    </>
                ) },
                { id: 'templates', title: '템플릿', onAdd: addTemplate, children: (
                    <>
                        {userTemplates.map(templateItem)}
                        <BuiltinFold title={`내장 템플릿 (${builtinTemplates.length})`}>{builtinTemplates.map(templateItem)}</BuiltinFold>
                    </>
                ) },
                { id: 'versions', title: '버전', onAdd: addVersion, children: (
                    <>
                        {versionList.length === 0 && <div className="px-2 py-1 text-[12px] text-[var(--c-texTer)]">버전이 없습니다. + 로 현재 시점을 지정합니다</div>}
                        {versionList.map(v => <VersionItem key={v.id} v={v} now={now} onRestore={() => restore(v)} />)}
                    </>
                ) },
                { id: 'mine', title: '내 변경사항', children: (
                    <>
                        {mineUndo.length + mineRedo.length === 0 && <div className="px-2 py-1 text-[12px] text-[var(--c-texTer)]">이 세션에서 바꾼 것이 없습니다</div>}
                        {mineRedo.map(g => <GroupItem key={g.id} g={g} docLabel={docLabel} now={now} dim mine />)}
                        {mineUndo.map(g => <GroupItem key={g.id} g={g} docLabel={docLabel} now={now} mine />)}
                    </>
                ) },
                { id: 'global', title: '변경사항', children: global.map(g => <GroupItem key={g.id} g={g} docLabel={docLabel} now={now} />) },
            ]} />
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
