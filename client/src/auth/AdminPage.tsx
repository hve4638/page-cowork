// admin 전용 페이지(/admin): 승인 대기 처리와 전체 사용자 목록. 접근 제한은 App 의 라우트에서 건다.
import { useCallback, useEffect, useState } from 'react';
import { approve, fetchPending, fetchUsers, type AdminUser, type PendingUser } from './api';

const ROLE_LABEL = { admin: '관리자', member: '멤버' } as const;
const STATUS_LABEL = { pending: '승인 대기', active: '활성' } as const;

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
                    <div key={u.id} className="flex items-center gap-2 py-0.5">
                        <span>{u.login_id}</span>
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
                <table className="w-full border-collapse text-[13px]">
                    <thead>
                        <tr className="text-left text-[var(--c-texSec)] border-b border-[var(--c-borPri)]">
                            <th className="py-1 pr-2 font-normal">아이디</th>
                            <th className="py-1 pr-2 font-normal">이메일</th>
                            <th className="py-1 pr-2 font-normal">역할</th>
                            <th className="py-1 font-normal">상태</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map(u => (
                            <tr key={u.id} className="border-b border-[var(--c-borPri)]/50">
                                <td className="py-1 pr-2">{u.login_id}</td>
                                <td className="py-1 pr-2">{u.email}</td>
                                <td className="py-1 pr-2">{ROLE_LABEL[u.role]}</td>
                                <td className="py-1">{STATUS_LABEL[u.status]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </>
    );
}
