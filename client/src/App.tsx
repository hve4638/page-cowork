import { useEffect, useState } from 'react';
import { connect, disconnect, useMeta } from '@/sync/store';
import { table } from '@/sync/handle';
import { Notice, type NoticeRow } from '@/modules/Notice';
import { BlockDoc, type BlockRow } from '@/modules/BlockDoc';
import { LoginGate } from '@/auth/LoginGate';
import { AdminPanel } from '@/auth/AdminPanel';
import { fetchMe, logout, type Me } from '@/auth/api';
import './notion.css';

// ── 페이지 조립 (하드코딩) — 모듈과 그 DB 스코프를 이 자리에서 선언한다 ──
function HomePage() {
    return (
        <>
            <Notice title="공지사항" db={table<NoticeRow>('notices', 'rw')} />
            <BlockDoc title="블럭 문서" docId="home" db={table<BlockRow>('blocks', 'rw')} />
        </>
    );
}

function Workspace({ me }: { me: Me }) {
    const { connected } = useMeta();
    useEffect(() => { connect(); return () => disconnect(); }, []);

    const doLogout = async () => {
        disconnect();
        await logout();
        location.reload();
    };

    return (
        <div className="h-full overflow-y-auto">
            {!connected && (
                <div className="fixed top-0 left-0 right-0 z-30 bg-[#bb3322] text-white text-center py-1 text-[13px]">
                    연결이 끊겼습니다 — 재연결 중…
                </div>
            )}
            {/* 노션 탑바와 같은 44px 높이 */}
            <header className="sticky top-0 z-20 h-11 flex items-center justify-end gap-1 px-3 bg-[var(--c-bacPri)] text-sm">
                <span className="text-[var(--c-texSec)] px-2">{me.login_id}{me.role === 'admin' ? ' (admin)' : ''}</span>
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={doLogout}>
                    로그아웃
                </button>
            </header>
            {/* 노션 페이지 레이아웃: 콘텐츠 폭 720px, 좌우 여백 최소 96px, 하단 30vh */}
            <main className="px-24 pb-[30vh]">
                <div className="max-w-[720px] mx-auto">
                    <h1 className="notion-page-title">cowork</h1>
                    {me.role === 'admin' && <AdminPanel />}
                    <HomePage />
                </div>
            </main>
        </div>
    );
}

function App() {
    const [me, setMe] = useState<Me | null | undefined>(undefined);
    useEffect(() => { fetchMe().then(setMe); }, []);

    if (me === undefined) return null; // 세션 확인 중
    return (
        <div className="notion-app w-full h-full">
            {me ? <Workspace me={me} /> : <LoginGate onLogin={setMe} />}
        </div>
    );
}

export default App;
