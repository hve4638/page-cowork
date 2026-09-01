// admin 전용: 승인 대기 계정 목록. 대기자가 없으면 아무것도 그리지 않는다.
import { useCallback, useEffect, useState } from 'react';
import { approve, fetchPending, type PendingUser } from './api';

export function AdminPanel() {
    const [pending, setPending] = useState<PendingUser[]>([]);

    const reload = useCallback(() => { fetchPending().then(setPending); }, []);
    useEffect(reload, [reload]);

    if (!pending.length) return null;
    return (
        <section className="border border-[#e1b52e]/60 bg-[#fdf6e3] rounded-md my-4 px-3 py-2 text-sm">
            <div className="font-semibold mb-1">승인 대기 {pending.length}명</div>
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
    );
}
