import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router';
import { connect, disconnect, useMeta } from '@/sync/store';
import { table } from '@/sync/handle';
import { BlockDoc, pageTitle, type BlockRow, type FileRow, type SubpageRow } from '@/modules/BlockDoc';
import { SidePeek } from '@/modules/SidePeek';
import { Sidebar, SidebarToggle, type RecentEditRow } from '@/modules/Sidebar';
import type { RecordingRow } from '@/modules/recorder';
import { PageProps, type PagePropRow } from '@/modules/props';
import { LoginPage, RedirectToLogin } from '@/auth/LoginPage';
import { AdminPage } from '@/auth/AdminPage';
import { fetchMe, logout, type Me } from '@/auth/api';
import './notion.css';

// 페이지 하나 = subpages 행(제목) + 그 id 를 doc_id 로 쓰는 블럭 문서. 홈도 같은 구조로 id 가 'home' 으로 고정된 행이다 (서버가 만든다).
// 제목(input)은 subpages.title 과 직접 묶여 입력마다 동기화된다 — 링크 블럭과 브레드크럼이 같은 행을 읽으므로 즉시 반영된다.
const HOME_PAGE_ID = 'home';

function Page() {
    const { pageId = HOME_PAGE_ID } = useParams();
    const subpages = table<SubpageRow>('subpages', 'rw');
    const page = subpages.useRows().find(p => p.id === pageId);
    const { loaded } = useMeta();
    useEffect(() => { if (loaded) document.title = pageTitle(page); }, [loaded, page]); // 브라우저 탭 제목도 저장된 제목을 따른다
    if (!loaded) return null; // 첫 스냅샷 전에는 없는 페이지인지 알 수 없다
    if (!page || page.deleted_at) return <h1 className="notion-page-title text-[var(--c-texTer)]">{pageTitle(undefined)}</h1>; // 삭제 표시된 페이지도 없는 것으로 보인다
    const props = table<PagePropRow>('page_props', 'rw');
    return (
        <>
            <input
                className="notion-page-title"
                placeholder="제목 없음"
                value={page.title}
                onChange={e => subpages.update({ id: page.id, title: e.target.value })}
            />
            <PageProps docId={page.id} props={props} />
            <BlockDoc docId={page.id} db={table<BlockRow>('blocks', 'rw')} subpages={subpages} props={props} files={table<FileRow>('files', 'ro')} recordings={table<RecordingRow>('recordings', 'ro')} />
        </>
    );
}

// 탑바의 현재 위치 경로: "<홈 제목> > 서브페이지" 형태. 첫 항목은 홈 행의 제목을 읽고, 홈 자체가 아니면 홈으로 가는 링크가 된다.
// to 가 있는 항목은 그 경로로 이동하는 링크가 된다.
function Breadcrumb({ path }: { path: { label: string; to?: string }[] }) {
    const pages = table<SubpageRow>('subpages', 'ro').useRows();
    const { loaded } = useMeta();
    const home = { label: loaded ? pageTitle(pages.find(p => p.id === HOME_PAGE_ID)) : '', to: path.length ? '/p/cowork' : undefined };
    const itemCls = 'px-1.5 py-0.5 rounded-md hover:bg-[var(--ca-bacIntTra)] cursor-pointer';
    return (
        <nav className="flex items-center gap-0.5 min-w-0">
            {[home, ...path].map((seg, i) => (
                <span key={i} className="flex items-center gap-0.5 min-w-0 truncate">
                    {i > 0 && <span className="text-[var(--c-texTer)] px-0.5">&gt;</span>}
                    {seg.to
                        ? <Link to={seg.to} className={itemCls}>{seg.label}</Link>
                        : <span className={itemCls}>{seg.label}</span>}
                </span>
            ))}
        </nav>
    );
}

function SubPageCrumb() {
    const { pageId } = useParams();
    const page = table<SubpageRow>('subpages', 'ro').useRows().find(p => p.id === pageId);
    const { loaded } = useMeta();
    return <Breadcrumb path={[{ label: loaded ? pageTitle(page) : '' }]} />;
}

function Workspace({ me }: { me: Me }) {
    const { connected } = useMeta();
    useEffect(() => { connect(); return () => disconnect(); }, []);

    const doLogout = async () => {
        disconnect();
        await logout();
        location.reload();
    };

    // 왼쪽 사이드바, 본문 열(스크롤), 오른쪽 사이드 패널(PDF 뷰어)을 나란히 둔다. 양쪽이 열리면 본문 열만 좁아진다.
    return (
        <div className="h-full flex">
            <Sidebar me={me} subpages={table<SubpageRow>('subpages', 'ro')} recents={table<RecentEditRow>('recent_edits', 'ro')} props={table<PagePropRow>('page_props', 'ro')} />
            <div className="flex-1 min-w-0 overflow-y-auto">
                {!connected && (
                    <div className="fixed top-0 left-0 right-0 z-30 bg-[#bb3322] text-white text-center py-1 text-[13px]">
                        연결이 끊겼습니다 — 재연결 중…
                    </div>
                )}
                {/* 노션 탑바와 같은 44px 높이, 투명 배경. 좌측은 경로 표시(브레드크럼) 자리다 */}
                <header className="sticky top-0 z-20 h-11 flex items-center gap-1 px-3 bg-transparent text-sm">
                    <SidebarToggle />
                    <Routes>
                        <Route path="/p/cowork/:pageId" element={<SubPageCrumb />} />
                        <Route path="/admin" element={<Breadcrumb path={[{ label: '관리' }]} />} />
                        <Route path="*" element={<Breadcrumb path={[]} />} />
                    </Routes>
                    <span className="flex-1" />
                    <span className="hidden sm:inline text-[var(--c-texSec)] px-2">{me.login_id}{me.role === 'admin' ? ' (admin)' : ''}</span>
                    <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={doLogout}>
                        로그아웃
                    </button>
                </header>
                {/* 노션 페이지 레이아웃: 콘텐츠 폭 720px, 좌우 여백 최소 96px(좁은 화면은 16px), 하단 30vh */}
                <main className="px-4 md:px-24 pb-[30vh]">
                    <div className="max-w-[720px] mx-auto">
                        <Routes>
                            <Route path="/p/cowork" element={<Page />} />
                            <Route path="/p/cowork/:pageId" element={<Page />} />
                            <Route path="/admin" element={me.role === 'admin' ? <AdminPage /> : <Navigate to="/p/cowork" replace />} />
                            <Route path="*" element={<Navigate to="/p/cowork" replace />} />
                        </Routes>
                    </div>
                </main>
            </div>
            <SidePeek />
        </div>
    );
}

function App() {
    const [me, setMe] = useState<Me | null | undefined>(undefined);
    useEffect(() => { fetchMe().then(setMe); }, []);

    if (me === undefined) return null; // 세션 확인 중
    return (
        <div className="notion-app w-full h-full">
            <Routes>
                <Route path="/login" element={<LoginPage me={me} onLogin={setMe} />} />
                <Route path="/signup" element={<LoginPage me={me} onLogin={setMe} mode="signup" />} />
                <Route path="*" element={me ? <Workspace me={me} /> : <RedirectToLogin />} />
            </Routes>
        </div>
    );
}

export default App;
