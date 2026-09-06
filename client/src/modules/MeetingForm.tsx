// 새 회의 생성 창. 회의 보드의 "새 회의" 를 누르면 오른쪽 패널(SidePeek)에 떠서 명칭·일시·목적을 받고,
// 확인하면 회의록 템플릿(templates.meetingNote)으로 페이지·속성·본문을 WS insert 한 뒤 그 회의록으로 들어간다.
// PagePeek 처럼 SidePeek 이 lazy import 로 불러 BlockDoc 과의 import 순환을 피한다.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { table } from '@/sync/handle';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { fromLocalInput, toLocalInput, type PagePropRow } from './props';
import { meetingNote } from './templates';

const field = 'h-9 px-3 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px] focus:ring-2 focus:ring-[var(--c-bluBacAccPri)]/40';

export default function MeetingForm({ boardId, close }: { boardId: string; close: () => void }) {
    const subpages = table<SubpageRow>('subpages', 'rw');
    const props = table<PagePropRow>('page_props', 'rw');
    const blocks = table<BlockRow>('blocks', 'rw');
    const pages = subpages.useRows();
    const navigate = useNavigate();
    const n = pages.filter(p => p.kind === 'meeting' && p.board_id === boardId).length + 1; // 이 보드의 몇 번째 회의인지 (지운 것 포함)
    const [title, setTitle] = useState(`회의 ${n}`);
    const [heldAt, setHeldAt] = useState(() => toLocalInput(Math.floor(Date.now() / 60000) * 60000)); // 지금, 분 단위
    const [purpose, setPurpose] = useState('');
    const [members, setMembers] = useState<string[] | null>(null); // 팀원별 탭 이름표. 서버의 active 사용자 이름으로 채운다
    useEffect(() => {
        let alive = true;
        fetch('/api/users')
            .then(r => (r.ok ? r.json() : { users: [] }))
            .then(d => { if (alive) setMembers((d.users as { login_id: string }[]).map(u => u.login_id)); })
            .catch(() => { if (alive) setMembers([]); });
        return () => { alive = false; };
    }, []);

    const submit = () => {
        const t = title.trim();
        if (!t) return;
        const draft = meetingNote({
            boardId, title: t, heldAt: fromLocalInput(heldAt), purpose: purpose.trim(), members: members ?? [],
            pos: Math.max(0, ...pages.map(p => p.pos)) + 1,
        });
        if (!subpages.insert(draft.page)) { alert('연결이 끊겨 회의를 만들지 못했습니다.'); return; }
        draft.props.forEach(p => props.insert(p));
        draft.blocks.forEach(b => blocks.insert(b));
        close();
        navigate(`/p/cowork/${draft.page.id}`);
    };

    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate">📅 새 회의</span>
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            <form className="p-5 flex flex-col gap-4 text-sm" onSubmit={e => { e.preventDefault(); submit(); }}>
                <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">회의 명칭</span>
                    <input autoFocus className={field} value={title} onChange={e => setTitle(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">일시</span>
                    <input className={field} type="datetime-local" value={heldAt} onChange={e => setHeldAt(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">목적</span>
                    <textarea className={`${field} h-auto py-2 min-h-20 resize-y`} value={purpose} placeholder="이 회의에서 정하거나 확인할 것" onChange={e => setPurpose(e.target.value)} />
                </label>
                <div className="text-[12px] text-[var(--c-texTer)]">
                    {members === null ? '팀원 목록을 불러오는 중…' : members.length ? `팀원별 자료 탭: ${members.join(', ')}` : '팀원별 자료 탭 없이 만듭니다.'}
                </div>
                <div className="flex gap-2 justify-end">
                    <button type="button" className="h-8 px-3 rounded-full text-[13px] cursor-pointer bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!" onClick={close}>취소</button>
                    <button type="submit" className="h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95 disabled:opacity-50" disabled={!title.trim() || members === null}>
                        회의록 만들기
                    </button>
                </div>
            </form>
        </>
    );
}
