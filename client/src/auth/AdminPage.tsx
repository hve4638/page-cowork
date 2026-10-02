// admin 전용 페이지(/admin): 승인 대기 처리와 전체 사용자 목록. 접근 제한은 App 의 라우트에서 건다.
import { useCallback, useEffect, useState } from 'react';
import { approve, fetchPending, fetchUsers, type AdminUser, type PendingUser } from './api';

const ROLE_LABEL = { admin: '관리자', member: '멤버' } as const;
const STATUS_LABEL = { pending: '승인 대기', active: '활성' } as const;
// 백업·복원은 서버가 죽은 상황에서도 써야 하므로 화면 기능 없이 CLI 로만 한다 (2026-10-02 admin-backup-restore). 절차는 README 백업·복원 절과 같다
const BACKUP_COMMANDS = `# 서버를 켠 채 백업 (live)
docker compose exec cowork pnpm backup

# 서버를 멈추고 백업 (cold)
docker compose stop cowork
docker compose run --rm cowork pnpm backup
docker compose start cowork

# 복원 (서버가 멈춰 있어야 합니다)
docker compose stop cowork
docker compose run --rm cowork pnpm restore <파일>.tar.gz
docker compose start cowork`;

export function AdminPage() {
    const [pending, setPending] = useState<PendingUser[]>([]);
    const [users, setUsers] = useState<AdminUser[]>([]);

    const reload = useCallback(() => {
        fetchPending().then(setPending);
        fetchUsers().then(setUsers);
    }, []);
    useEffect(reload, [reload]);

    return (
        <>
            <h1 className="notion-page-title">관리</h1>

            <section className="my-4 text-sm">
                <h2 className="font-semibold mb-1">승인 대기 {pending.length}명</h2>
                {pending.length === 0 && <p className="text-[var(--c-texSec)] text-[13px]">승인 대기 중인 계정이 없습니다.</p>}
                {pending.map(u => (
                    <div key={u.id} className="flex flex-wrap items-center gap-2 py-0.5">
                        <span>{u.name}</span>
                        <span className="text-[var(--c-texSec)] text-[13px]">{u.email}</span>
                        <button
                            className="text-[13px] px-2 py-0.5 border border-[var(--c-borPri)] rounded cursor-pointer bg-white"
                            onClick={async () => { await approve(u.id); reload(); }}
                        >승인</button>
                    </div>
                ))}
            </section>

            <section className="my-4 text-sm">
                <h2 className="font-semibold mb-1">사용자 {users.length}명</h2>
                <div className="overflow-x-auto"><table className="w-full border-collapse text-[13px]">
                    <thead>
                        <tr className="text-left text-[var(--c-texSec)] border-b border-[var(--c-borPri)]">
                            <th className="py-1 pr-2 font-normal">닉네임</th>
                            <th className="py-1 pr-2 font-normal">이메일</th>
                            <th className="py-1 pr-2 font-normal">역할</th>
                            <th className="py-1 font-normal">상태</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(u => (
                            <tr key={u.id} className="border-b border-[var(--c-borPri)]/50">
                                <td className="py-1 pr-2">{u.name}</td>
                                <td className="py-1 pr-2">{u.email}</td>
                                <td className="py-1 pr-2">{ROLE_LABEL[u.role]}</td>
                                <td className="py-1">{STATUS_LABEL[u.status]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table></div>
            </section>

            <section className="my-4 text-sm">
                <h2 className="font-semibold mb-1">백업·복원</h2>
                <p className="text-[13px] mb-1">
                    서버가 뜨지 않을 때도 쓸 수 있도록 화면이 아니라 배포 디렉터리에서 명령으로 합니다.
                    백업은 <code>data/backups/</code> 에 <code>cowork-backup-YYMMDD-HHMMSS-v번호-live|cold.tar.gz</code> 로 남습니다.
                </p>
                <pre className="text-[12px] bg-[var(--c-bacSec)] p-2 rounded overflow-x-auto">{BACKUP_COMMANDS}</pre>
                <p className="text-[var(--c-texSec)] text-[13px] mt-1">
                    live 는 받는 동안 끝난 녹음·업로드가 어긋날 수 있습니다. 버전을 올리기 전처럼 확실해야 할 때는 서버를 멈추고 받습니다(cold).
                    복원하면 현재 데이터는 <code>data/backups/&lt;시각&gt;-pre-restore/</code> 로 옮겨지고, 로그인 세션도 백업 시점으로 돌아가므로 다시 로그인해야 할 수 있습니다.
                </p>
            </section>
        </>
    );
}
