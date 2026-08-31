// 공지사항 모듈. ro·rw 어느 핸들이든 받는다 — rw 일 때만 입력폼과 삭제 버튼이 생긴다.
// notices 테이블 스키마는 아직 확정 전 초안이다.
import { useState } from 'react';
import { rid } from '@/sync/store';
import type { RoTable, RwTable } from '@/sync/handle';
import { ModuleFrame } from './ModuleFrame';

export type NoticeRow = { id: string; text: string; ts: number; author_id?: string };

export function Notice({ title, db }: { title: string; db: RoTable<NoticeRow> | RwTable<NoticeRow> }) {
    const rows = db.useRows();
    const [text, setText] = useState('');
    const rw = 'insert' in db ? db : null; // 타입 좁히기 — ro 핸들에는 insert 자체가 없다

    const submit = () => {
        if (!rw || !text.trim()) return;
        if (rw.insert({ id: rid(8), text: text.trim(), ts: Date.now() })) setText('');
    };

    return (
        <ModuleFrame title={title} db={db}>
            {[...rows].sort((a, b) => b.ts - a.ts).map(r => (
                <div key={r.id} className="group flex items-baseline gap-2 py-1 border-b border-black/5 text-[15px]">
                    <span>{r.text}</span>
                    {rw && (
                        <button
                            className="invisible group-hover:visible text-xs text-[#bb3322] cursor-pointer"
                            onClick={() => rw.remove(r.id)}
                        >삭제</button>
                    )}
                </div>
            ))}
            {rw && (
                <div className="flex gap-1.5 mt-2">
                    <input
                        className="flex-1 text-sm px-2 py-1 border border-black/20 rounded"
                        placeholder="새 공지…"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if (e.nativeEvent.isComposing) return; // 한글 조합 확정용 키 입력은 무시
                            if (e.key === 'Enter') submit();
                        }}
                    />
                    <button className="text-[13px] px-2.5 py-1 border border-black/20 rounded cursor-pointer bg-[#f7f7f5]" onClick={submit}>
                        등록
                    </button>
                </div>
            )}
        </ModuleFrame>
    );
}
