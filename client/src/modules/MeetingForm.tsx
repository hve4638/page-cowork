// 새 회의 생성 창. 회의 보드의 "새 회의" 를 누르면 오른쪽 패널(SidePeek)에 떠서 명칭·일시·목적을 받고,
// 확인하면 내장 매크로 "새 회의"(macros.BUILTIN_MACROS)를 실행한다 — 회의록 페이지를 만들고 템플릿 '회의록' 을 넣고 일시 속성을 채운 뒤 그 회의록으로 들어간다.
// 템플릿은 사이드바 "템플릿" 의 회의록 페이지라서 사용자가 고친 본문·속성이 그대로 새 회의에 들어간다.
// PagePeek 처럼 SidePeek 이 lazy import 로 불러 BlockDoc 과의 import 순환을 피한다.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { table } from '@/sync/handle';
import { pageTitle, type BlockRow, type SubpageRow } from './BlockDoc';
import { fromLocalInput, toLocalInput, type PagePropRow } from './props';
import { BUILTIN_MACROS, runMacro } from './macros';
import { MEETING_TEMPLATE_ID, templatePages } from './templates';

const field = 'h-9 px-3 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px] focus:ring-2 focus:ring-[var(--c-bluBacAccPri)]/40';

export default function MeetingForm({ boardId, close }: { boardId: string; close: () => void }) {
    const subpages = table<SubpageRow>('subpages', 'rw');
    const props = table<PagePropRow>('page_props', 'rw');
    const blocks = table<BlockRow>('blocks', 'rw');
    const pages = subpages.useRows();
    const navigate = useNavigate();
    // 보드 블럭이 고른 템플릿 (style.template). 보드는 ref 로 찾는다. 없거나 지워졌으면 내장 회의록
    const board = blocks.useRows().find(b => b.type === 'meetings' && b.ref === boardId);
    const template = templatePages(pages).find(t => t.id === board?.style?.template) ?? templatePages(pages).find(t => t.id === MEETING_TEMPLATE_ID);
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
        close();
        const err = runMacro(BUILTIN_MACROS.find(m => m.id === 'builtin:new-meeting')!, {
            docId: 'home', vars: { 제목: t, 일시: fromLocalInput(heldAt), 목적: purpose.trim(), 팀원: members ?? [], 보드: boardId, 템플릿: template?.id ?? MEETING_TEMPLATE_ID },
            blocks, subpages, props, navigate,
        });
        if (err) alert(err);
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
                <div className="text-[12px] text-[var(--c-texTer)]">템플릿: {template ? pageTitle(template) : '없음 (사이드바에서 템플릿을 만드세요)'}</div>
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
