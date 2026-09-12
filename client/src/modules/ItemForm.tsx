// 새 마일스톤·작업·티켓 생성 창. 보드 블럭의 "+ 새 항목" 을 누르면 오른쪽 패널(SidePeek)에 떠서 제목·상위·담당자·기한을 받고,
// 확인하면 내장 매크로 "새 <종류>"(macros.BUILTIN_MACROS)를 한 undo 묶음으로 실행한다 — 항목 페이지를 만들고 상태(todo)·담당자·기한 속성을 채운다.
// 만든 뒤에는 이동하지도 패널에 띄우지도 않고 창만 닫는다. 항목은 보드에 나타난다 (회의록과 같은 규칙, 사용자 결정 2026-09-08).
// DB 는 보드가 정한다 (dbId). 상위는 같은 DB 의 한 단계 위 항목 중에서 고르고 비워 둘 수 있다.
// MeetingForm 처럼 SidePeek 이 lazy import 로 불러 BlockDoc 과의 import 순환을 피한다.
import { useState } from 'react';
import { table } from '@/sync/handle';
import { group } from '@/sync/history';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { fromLocalInput, PeopleEditor, type PagePropRow } from './props';
import { BUILTIN_MACROS, itemMacroId, runMacro } from './macros';
import { ITEM_META, STATUSES, type ItemKind } from './itemKinds';

const field = 'h-9 px-3 rounded-lg bg-[var(--c-bacSec)] outline-none text-[14px] focus:ring-2 focus:ring-[var(--c-bluBacAccPri)]/40';

export default function ItemForm({ dbId, kind, close }: { dbId: string; kind: ItemKind; close: () => void }) {
    const subpages = table<SubpageRow>('subpages', 'rw');
    const props = table<PagePropRow>('page_props', 'rw');
    const blocks = table<BlockRow>('blocks', 'rw');
    const pages = subpages.useRows();
    const meta = ITEM_META[kind];
    const parents = meta.parent ? pages.filter(p => p.kind === meta.parent && p.db_id === dbId).sort((a, b) => a.title.localeCompare(b.title)) : [];
    const [title, setTitle] = useState('');
    const [parent, setParent] = useState('');
    const [assignees, setAssignees] = useState<string[]>([]);
    const [due, setDue] = useState('');

    const submit = () => {
        const t = title.trim();
        if (!t) return;
        const err = group(() => runMacro(BUILTIN_MACROS.find(m => m.id === itemMacroId(kind))!, {
            docId: 'home', vars: { 제목: t, DB: dbId, 상위: parent, 상태: STATUSES[0], 담당자: assignees, 기한: fromLocalInput(due) },
            blocks, subpages, props,
            navigate: () => {},
        }));
        if (err) { alert(err); return; }
        close();
    };

    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate">{meta.icon} 새 {meta.label}</span>
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            <form className="p-5 flex flex-col gap-4 text-sm" onSubmit={e => { e.preventDefault(); submit(); }}>
                <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">제목</span>
                    <input autoFocus className={field} value={title} onChange={e => setTitle(e.target.value)} />
                </label>
                {meta.parent && (
                    <label className="flex flex-col gap-1">
                        <span className="text-[12px] text-[var(--c-texSec)]">상위 {ITEM_META[meta.parent].label}</span>
                        <select className={`${field} cursor-pointer`} value={parent} onChange={e => setParent(e.target.value)}>
                            <option value="">없음</option>
                            {parents.map(p => <option key={p.id} value={p.id}>{p.title || '제목 없음'}</option>)}
                        </select>
                        {!parents.length && <span className="text-[12px] text-[var(--c-texTer)]">이 DB 에 {ITEM_META[meta.parent].label}이 아직 없습니다.</span>}
                    </label>
                )}
                <div className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">담당자</span>
                    <PeopleEditor value={assignees} onChange={setAssignees} />
                </div>
                <label className="flex flex-col gap-1">
                    <span className="text-[12px] text-[var(--c-texSec)]">기한</span>
                    <input className={field} type="datetime-local" value={due} onChange={e => setDue(e.target.value)} />
                </label>
                <div className="flex gap-2 justify-end">
                    <button type="button" className="h-8 px-3 rounded-full text-[13px] cursor-pointer bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!" onClick={close}>취소</button>
                    <button type="submit" className="h-8 px-3 rounded-full text-[13px] font-medium cursor-pointer bg-[var(--c-bluBacAccPri)]! text-white hover:brightness-95 disabled:opacity-50" disabled={!title.trim()}>
                        {meta.label} 만들기
                    </button>
                </div>
            </form>
        </>
    );
}
