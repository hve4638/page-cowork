import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router';
import { connect, disconnect, useMeta } from '@/sync/store';
import { table } from '@/sync/handle';
import { Notice, type NoticeRow } from '@/modules/Notice';
import { BlockDoc, pageTitle, type BlockRow, type FileRow, type SubpageRow } from '@/modules/BlockDoc';
import { SidePeek } from '@/modules/SidePeek';
import { LoginPage, RedirectToLogin } from '@/auth/LoginPage';
import { AdminPage } from '@/auth/AdminPage';
import { fetchMe, logout, type Me } from '@/auth/api';
import './notion.css';

// ── 페이지 조립 (하드코딩) — 모듈과 그 DB 스코프를 이 자리에서 선언한다 ──
function HomePage({ me }: { me: Me }) {
    return (
        <>
            <h1 className="notion-page-title">cowork</h1>
            {me.role === 'admin' && (
                <Link to="/admin" className="fixed left-3 bottom-3 z-20 text-[13px] text-[var(--c-texSec)] px-2 py-1 rounded-md hover:bg-[var(--ca-bacIntTra)]">
                    관리 페이지
                </Link>
            )}
            <Notice title="공지사항" db={table<NoticeRow>('notices', 'rw')} />
            <BlockDoc title="블럭 문서" docId="home" db={table<BlockRow>('blocks', 'rw')} subpages={table<SubpageRow>('subpages', 'rw')} files={table<FileRow>('files', 'ro')} />
        </>
    );
}

// 서브페이지: URL 의 uuid 를 그대로 blocks.doc_id 스코프로 쓴다. 제목(h1)은 subpages.title 과 직접 묶여 있어
// 입력마다 동기화된다 — 링크 블럭과 브레드크럼이 같은 행을 읽으므로 즉시 반영된다.
function SubPage() {
    const { pageId } = useParams();
    const subpages = table<SubpageRow>('subpages', 'rw');
    const page = subpages.useRows().find(p => p.id === pageId);
    const { loaded } = useMeta();
    if (!pageId) return <Navigate to="/p/cowork" replace />;
    if (!loaded) return null; // 첫 스냅샷 전에는 없는 페이지인지 알 수 없다
    if (!page) return <h1 className="notion-page-title text-[var(--c-texTer)]">{pageTitle(undefined)}</h1>;
    return (
        <>
            <input
                className="notion-page-title"
                placeholder="제목 없음"
                value={page.title}
                onChange={e => subpages.update({ id: page.id, title: e.target.value })}
            />
            <BlockDoc title="블럭 문서" docId={pageId} db={table<BlockRow>('blocks', 'rw')} subpages={subpages} files={table<FileRow>('files', 'ro')} />
        </>
    );
}

// 탑바의 현재 위치 경로: "Cowork > 서브페이지1 > 서브페이지2" 형태.
// to 가 있는 항목은 그 경로로 이동하는 링크가 된다.
function Breadcrumb({ path }: { path: { label: string; to?: string }[] }) {
    const itemCls = 'px-1.5 py-0.5 rounded-md hover:bg-[var(--ca-bacIntTra)] cursor-pointer';
    return (
        <nav className="flex items-center gap-0.5">
            {path.map((seg, i) => (
                <span key={i} className="flex items-center gap-0.5">
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
    return <Breadcrumb path={[{ label: 'Cowork', to: '/p/cowork' }, { label: loaded ? pageTitle(page) : '' }]} />;
}

function Workspace({ me }: { me: Me }) {
    const { connected } = useMeta();
    useEffect(() => { connect(); return () => disconnect(); }, []);

    const doLogout = async () => {
        disconnect();
        await logout();
        location.reload();
    };

    // 본문 열(스크롤)과 오른쪽 사이드 패널(PDF 뷰어)을 나란히 둔다. 패널이 열리면 본문 열만 좁아진다.
    return (
        <div className="h-full flex">
            <div className="flex-1 min-w-0 overflow-y-auto">
                {!connected && (
                    <div className="fixed top-0 left-0 right-0 z-30 bg-[#bb3322] text-white text-center py-1 text-[13px]">
                        연결이 끊겼습니다 — 재연결 중…
                    </div>
                )}
                {/* 노션 탑바와 같은 44px 높이, 투명 배경. 좌측은 경로 표시(브레드크럼) 자리다 */}
                <header className="sticky top-0 z-20 h-11 flex items-center gap-1 px-3 bg-transparent text-sm">
                    <Routes>
                        <Route path="/p/cowork/:pageId" element={<SubPageCrumb />} />
                        <Route path="/admin" element={<Breadcrumb path={[{ label: 'Cowork', to: '/p/cowork' }, { label: '관리' }]} />} />
                        <Route path="*" element={<Breadcrumb path={[{ label: 'Cowork' }]} />} />
                    </Routes>
                    <span className="flex-1" />
                    <span className="text-[var(--c-texSec)] px-2">{me.login_id}{me.role === 'admin' ? ' (admin)' : ''}</span>
                    <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={doLogout}>
                        로그아웃
                    </button>
                </header>
                {/* 노션 페이지 레이아웃: 콘텐츠 폭 720px, 좌우 여백 최소 96px, 하단 30vh */}
                <main className="px-24 pb-[30vh]">
                    <div className="max-w-[720px] mx-auto">
                        <Routes>
                            <Route path="/p/cowork" element={<HomePage me={me} />} />
                            <Route path="/p/cowork/:pageId" element={<SubPage />} />
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
