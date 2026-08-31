import { useEffect, useState } from 'react';
import { connect, disconnect, useMeta } from '@/sync/store';
import { table } from '@/sync/handle';
import { Notice, type NoticeRow } from '@/modules/Notice';
import { BlockDoc, type BlockRow } from '@/modules/BlockDoc';
import { LoginGate } from '@/auth/LoginGate';
import { AdminPanel } from '@/auth/AdminPanel';
import { fetchMe, logout, type Me } from '@/auth/api';

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
            <main className="px-16 py-10">
                <div className="max-w-[760px] mx-auto">
                    <div className="flex items-baseline">
                        <h1 className="text-[26px] font-bold flex-1">cowork</h1>
                        <span className="text-sm text-[#666666] mr-3">{me.login_id}{me.role === 'admin' ? ' (admin)' : ''}</span>
                        <button className="text-[13px] px-2 py-0.5 border border-black/20 rounded cursor-pointer bg-[#f7f7f5]" onClick={doLogout}>
                            로그아웃
                        </button>
                    </div>
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
        <div className="w-full h-full bg-white text-[#2c2c2b]" style={{ colorScheme: 'light' }}>
            {me ? <Workspace me={me} /> : <LoginGate onLogin={setMe} />}
        </div>
    );
}

export default App;
