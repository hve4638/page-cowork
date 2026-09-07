// 매크로 편집기. 사이드바 "매크로" 의 항목을 클릭하면 오른쪽 패널(SidePeek)에 떠서 이름·아이콘·검색어·입력 변수·단계 목록을 편집한다.
// 값은 입력마다 바로 동기화한다 (페이지 속성과 같은 방식, LWW). 내장 매크로는 같은 화면을 읽기 전용으로 보인다.
import { table } from '@/sync/handle';
import type { SubpageRow } from './BlockDoc';
import { BUILTIN_MACROS, isBuiltin, newStep, STEP_OPS, type MacroRow, type Step } from './macros';
import { templatePages } from './templates';
import type { PropType } from './props';

const field = 'h-8 px-2 rounded-md bg-[var(--c-bacSec)] outline-none text-[13px] focus:ring-2 focus:ring-[var(--c-bluBacAccPri)]/40 disabled:opacity-70';
const PROP_TYPES: { type: PropType; label: string }[] = [{ type: 'text', label: '텍스트' }, { type: 'number', label: '숫자' }, { type: 'date', label: '날짜' }];
const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);


export default function MacroEditor({ id, close }: { id: string; close: () => void }) {
    const macros = table<MacroRow>('macros', 'rw');
    const rows = macros.useRows();
    const templates = templatePages(table<SubpageRow>('subpages', 'ro').useRows());
    const builtin = isBuiltin(id);
    const m = builtin ? BUILTIN_MACROS.find(r => r.id === id) : rows.find(r => r.id === id);
    const patch = (p: Partial<MacroRow>) => { if (!builtin) macros.update({ id, ...p }); };
    const setStep = (i: number, step: Step) => patch({ steps: m!.steps.map((s, j) => (j === i ? step : s)) });
    const remove = () => { if (confirm(`매크로 '${m?.name}' 을 지울까요?`)) { macros.remove(id); close(); } };

    const label = (text: string) => <span className="w-16 shrink-0 text-[12px] text-[var(--c-texSec)]">{text}</span>;
    const row = (text: string, input: React.ReactNode) => <label className="flex items-center gap-2">{label(text)}{input}</label>;
    // 단계 하나의 필드. op 별로 다르다
    const stepFields = (s: Step, i: number) => {
        if (s.op === 'create-page') return (
            <>
                <input className={`${field} flex-1`} disabled={builtin} placeholder="제목 ({{변수}} 가능)" value={s.title} onChange={e => setStep(i, { ...s, title: e.target.value })} />
                <select className={field} disabled={builtin} value={s.kind ?? ''} onChange={e => setStep(i, { ...s, kind: e.target.value === 'meeting' ? 'meeting' : '' })}>
                    <option value="">일반 페이지</option>
                    <option value="meeting">회의록</option>
                </select>
                {s.kind === 'meeting' && <input className={`${field} w-28`} disabled={builtin} placeholder="보드 키" value={s.board ?? ''} onChange={e => setStep(i, { ...s, board: e.target.value })} />}
            </>
        );
        if (s.op === 'insert-template') return (
            <select className={`${field} flex-1`} disabled={builtin} value={s.template} onChange={e => setStep(i, { ...s, template: e.target.value })}>
                <option value="">템플릿 선택</option>
                {templates.map(t => <option key={t.id} value={t.title}>{t.title || '제목 없음'}</option>)}
                {s.template && !templates.some(t => t.title === s.template) && <option value={s.template}>{s.template} (없음)</option>}
            </select>
        );
        if (s.op === 'set-prop') return (
            <>
                <input className={`${field} w-24`} disabled={builtin} placeholder="속성 이름" value={s.key} onChange={e => setStep(i, { ...s, key: e.target.value })} />
                <select className={field} disabled={builtin} value={s.type} onChange={e => setStep(i, { ...s, type: e.target.value as PropType })}>
                    {PROP_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>
                <input className={`${field} flex-1`} disabled={builtin} placeholder="값 ({{변수}} 가능)" value={s.value} onChange={e => setStep(i, { ...s, value: e.target.value })} />
            </>
        );
        return <span className="flex-1 text-[12px] text-[var(--c-texTer)]">앞 단계에서 만든(또는 현재) 페이지로 이동</span>;
    };

    return (
        <>
            <header className="h-11 shrink-0 flex items-center gap-1 px-3 text-sm border-b border-[var(--c-borPri)]">
                <span className="flex-1 truncate">{m ? `${m.icon || '⚡'} ${m.name || '이름 없음'}` : '⚡ 매크로'}{builtin ? ' (내장)' : ''}</span>
                {m && !builtin && <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)] text-[#b42318]" onClick={remove}>삭제</button>}
                <button className="text-[13px] px-2 py-1 rounded-md cursor-pointer hover:bg-[var(--ca-bacIntTra)]" onClick={close} aria-label="닫기">✕</button>
            </header>
            {!m ? <div className="p-4 text-sm text-[var(--c-texTer)]">삭제된 매크로</div> : (
                <div className="p-5 flex flex-col gap-3 text-sm">
                    {row('이름', <input className={`${field} flex-1`} disabled={builtin} value={m.name} onChange={e => patch({ name: e.target.value })} />)}
                    {row('아이콘', <input className={`${field} w-16`} disabled={builtin} value={m.icon} placeholder="⚡" onChange={e => patch({ icon: e.target.value })} />)}
                    {row('검색어', <input className={`${field} flex-1`} disabled={builtin} value={m.keywords.join(', ')} placeholder="쉼표로 구분" onChange={e => patch({ keywords: splitList(e.target.value) })} />)}
                    {row('입력 변수', <input className={`${field} flex-1`} disabled={builtin} value={m.inputs.join(', ')} placeholder="실행할 때 물어볼 변수 이름, 쉼표로 구분" onChange={e => patch({ inputs: splitList(e.target.value) })} />)}
                    <div className="text-[12px] text-[var(--c-texTer)]">'/{m.name}' 으로 실행합니다. 단계의 값에는 {'{{변수}}'} 를 쓸 수 있습니다.</div>
                    <div className="pt-2 text-[12px] font-medium text-[var(--c-texSec)]">단계</div>
                    {m.steps.map((s, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="w-4 text-[12px] text-[var(--c-texTer)] text-right">{i + 1}</span>
                            <select className={field} disabled={builtin} value={s.op} onChange={e => setStep(i, newStep(e.target.value as Step['op']))}>
                                {STEP_OPS.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                            </select>
                            {stepFields(s, i)}
                            {!builtin && <button className="px-1 bg-transparent! text-[var(--c-texTer)] hover:text-[var(--c-texPri)] cursor-pointer" title="단계 삭제" onClick={() => patch({ steps: m.steps.filter((_, j) => j !== i) })}>×</button>}
                        </div>
                    ))}
                    {!builtin && (
                        <button className="self-start h-8 px-3 rounded-full text-[13px] cursor-pointer bg-[var(--c-graBacSec)]! hover:bg-[#e6e5e3]!" onClick={() => patch({ steps: [...m.steps, newStep('insert-template')] })}>
                            + 단계 추가
                        </button>
                    )}
                </div>
            )}
        </>
    );
}
