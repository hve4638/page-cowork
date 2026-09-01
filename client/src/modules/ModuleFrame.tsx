// 모듈 공통 틀: 제목 옆에 스코프 배지를 붙여서 조립부 선언과 화면을 대응시킨다
import type { ReactNode } from 'react';
import type { Row } from '@/sync/store';
import type { RoTable } from '@/sync/handle';

export function ModuleFrame({ title, db, children }: { title: string; db: RoTable<Row>; children: ReactNode }) {
    return (
        <section className="border border-[var(--c-borPri)] rounded-md my-5">
            <header className="flex items-center gap-2 px-3 py-2 bg-[var(--c-bacSec)] border-b border-[var(--c-borPri)] rounded-t-md">
                <span className="text-sm font-semibold">{title}</span>
                <span className={`text-[11px] font-mono text-white rounded px-1.5 py-px ${db.mode === 'rw' ? 'bg-[var(--c-bluBacAccPri)]' : 'bg-[var(--c-icoSec)]'}`}>
                    {db.name} {db.mode}
                </span>
            </header>
            <div className="px-3 py-2">{children}</div>
        </section>
    );
}
