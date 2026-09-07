// 매크로: 순서대로 실행하는 명령(단계)의 목록. 사용자가 만든 것은 macros 테이블(전 사용자 공유)에 살고 '/<이름>' 으로 부른다.
// 내장 매크로(BUILTIN_MACROS)는 코드에 고정이며 사이드바의 "내장" 목록에 읽기 전용으로 보인다. 기존 '/' 명령(BlockDoc.SLASH_COMMANDS)도 같은 자리에 보인다.
// 단계는 회의 구현에 필요한 최소(페이지 만들기·템플릿 넣기·속성 설정·페이지 열기)부터 시작한다. 분기·루프는 후속 (사용자 결정 2026-09-07).
// 단계의 문자열 값에는 {{변수}} 를 쓸 수 있다. 변수는 실행 전에 채워지며(입력 변수는 실행 시 묻는다), 값 전체가 변수 하나면 원래 형을 유지한다 (templates.subst).
// 후속 티켓(item-meeting-link 의 /티켓 등)은 단계 종류를 늘리는 식으로 이 위에 얹는다.
import { readTable, rid } from '@/sync/store';
import type { RwTable } from '@/sync/handle';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { propId, type PagePropRow, type PropType } from './props';
import { findTemplate, instantiate, subst, type Vars } from './templates';

export type Step =
    | { op: 'create-page'; title: string; kind?: 'meeting' | ''; board?: string } // 페이지를 만들고 이후 단계의 대상으로 삼는다. '/' 에서 부른 일반 페이지는 캐럿 자리에 링크 블럭이 생긴다
    | { op: 'insert-template'; template: string }                                 // 템플릿(이름)을 대상 문서에 넣는다. '/' 에서 부르고 대상이 현재 문서면 캐럿 자리에
    | { op: 'set-prop'; key: string; type: PropType; value: string }             // 대상 페이지의 속성을 만들거나 값을 바꾼다
    | { op: 'open-page' };                                                         // 대상 페이지로 이동한다
export const STEP_OPS: { op: Step['op']; label: string }[] = [
    { op: 'create-page', label: '페이지 만들기' },
    { op: 'insert-template', label: '템플릿 넣기' },
    { op: 'set-prop', label: '속성 설정' },
    { op: 'open-page', label: '페이지 열기' },
];
export const newStep = (op: Step['op']): Step =>
    op === 'create-page' ? { op, title: '' } : op === 'insert-template' ? { op, template: '' } : op === 'set-prop' ? { op, key: '', type: 'text', value: '' } : { op };

export type MacroRow = {
    id: string;
    name: string;
    icon: string;
    keywords: string[];
    inputs: string[]; // 실행 전에 묻는 변수 이름
    steps: Step[];
    created_by?: string; created_at?: number; updated_at?: number; // 서버가 찍는다
};
export const isBuiltin = (id: string) => id.startsWith('builtin:');

// 새 회의 (MeetingForm 이 부른다). 제목·일시·목적·팀원·보드·템플릿은 폼이 채우는 변수다. 목적은 회의록 템플릿의 속성 값 '{{목적}}' 이 받는다.
// 템플릿은 회의 보드 블럭이 고른 것(style.template, 기본은 내장 회의록)의 id 다.
export const BUILTIN_MACROS: MacroRow[] = [
    {
        id: 'builtin:new-meeting', name: '새 회의', icon: '📅', keywords: [], inputs: ['제목', '일시', '목적', '팀원', '보드', '템플릿'],
        steps: [
            { op: 'create-page', title: '{{제목}}', kind: 'meeting', board: '{{보드}}' },
            { op: 'insert-template', template: '{{템플릿}}' },
            { op: 'set-prop', key: '일시', type: 'date', value: '{{일시}}' },
            { op: 'open-page' },
        ],
    },
];

export type NewBlock = Pick<BlockRow, 'type' | 'ref' | 'text'> & Partial<Pick<BlockRow, 'id' | 'style'>>;
export type MacroContext = {
    docId: string; // 실행을 시작한 문서
    vars: Vars;
    blocks: RwTable<BlockRow>; subpages: RwTable<SubpageRow>; props: RwTable<PagePropRow>;
    navigate: (to: string) => void;
    // '/' 에서 불렀을 때 캐럿 자리에 블럭을 꽂는 함수 (BlockDoc.insertSpecialAt). 없으면 문서 끝에 붙인다.
    insertAt?: (blocks: NewBlock[], extra?: { undo?: () => void; redo?: () => void }) => BlockRow[] | null;
};

const asStr = (s: string | undefined, vars: Vars) => { const v = subst(s ?? '', vars); return Array.isArray(v) ? v.join(', ') : v === null ? '' : String(v); };

// 단계를 차례로 실행한다. 실패하면(연결 끊김·템플릿 없음) 거기서 멈추고 이유를 돌려준다. 이미 실행된 단계는 되돌리지 않는다.
export function runMacro(macro: Pick<MacroRow, 'inputs' | 'steps'>, ctx: MacroContext): string | null {
    const vars: Vars = { ...ctx.vars };
    for (const name of macro.inputs) {
        if (name in vars) continue;
        const v = prompt(name);
        if (v === null) return null; // 취소
        vars[name] = v;
    }
    let target = ctx.docId;
    let created = false; // 이 실행이 만든 페이지가 대상이다 (캐럿이 아니라 문서 끝에 넣는다)
    for (const step of macro.steps) {
        if (step.op === 'create-page') {
            const pages = readTable('subpages') as SubpageRow[];
            const page: SubpageRow = {
                id: rid(16), title: asStr(step.title, vars), pos: Math.max(0, ...pages.map(p => p.pos)) + 1,
                kind: step.kind === 'meeting' ? 'meeting' : null, board_id: step.kind === 'meeting' ? asStr(step.board, vars) || null : null,
            };
            if (!ctx.subpages.insert(page)) return '연결이 끊겨 페이지를 만들지 못했습니다.';
            // 회의록은 보드가 목록으로 보여 주므로 링크 블럭을 두지 않는다. 일반 페이지는 링크 블럭이 유일한 입구다
            if (ctx.insertAt && !created && page.kind !== 'meeting') ctx.insertAt([{ type: 'subpage', ref: page.id, text: '' }], { redo: () => ctx.subpages.insert(page) });
            target = page.id; created = true;
        } else if (step.op === 'insert-template') {
            const name = asStr(step.template, vars);
            const tpl = findTemplate(name);
            if (!tpl) return `템플릿 '${name}' 이 없습니다.`;
            const existing = (readTable('blocks') as BlockRow[]).filter(b => b.doc_id === target && !b.parent_id);
            const { blocks, props } = instantiate(tpl.id, vars, target, Math.max(0, ...existing.map(b => b.pos)));
            const tops = blocks.filter(b => !b.parent_id), children = blocks.filter(b => b.parent_id);
            if (ctx.insertAt && !created) {
                // 캐럿 자리. 최상위는 insertAt 이 pos 를 매기고 undo 를 기록한다. 자식은 부모 삭제에 연쇄되므로 redo 때만 다시 만든다
                const news: NewBlock[] = tops.map(b => ({ id: b.id, type: b.type, ref: b.ref, text: b.text, style: b.style }));
                if (!ctx.insertAt(news, { redo: () => children.forEach(c => ctx.blocks.insert(c)) })) return '연결이 끊겨 템플릿을 넣지 못했습니다.';
                children.forEach(c => ctx.blocks.insert(c));
            } else {
                blocks.forEach(b => ctx.blocks.insert(b));
            }
            // 속성은 이 실행이 만든 페이지에만 복제한다. 기존 페이지의 캐럿에 꽂을 때는 블럭만 — 남의 페이지 속성을 늘리지 않고 undo 범위(블럭)와도 맞춘다
            if (created) {
                const cur = readTable('page_props') as PagePropRow[];
                for (const p of props) {
                    if (cur.some(x => x.id === p.id)) ctx.props.update({ id: p.id, value: p.value });
                    else ctx.props.insert(p);
                }
            }
        } else if (step.op === 'set-prop') {
            const key = asStr(step.key, vars);
            if (!key) continue;
            const v = subst(step.value, vars);
            const value = Array.isArray(v) ? v.join(', ') : v; // 속성 값에 목록은 없다
            const cur = readTable('page_props') as PagePropRow[];
            const id = propId(target, key);
            if (cur.some(x => x.id === id)) ctx.props.update({ id, value });
            else ctx.props.insert({ id, doc_id: target, key, type: step.type, value, pos: Math.max(0, ...cur.filter(x => x.doc_id === target).map(x => x.pos)) + 1 });
        } else if (step.op === 'open-page') {
            ctx.navigate(`/p/cowork/${target}`);
        }
    }
    return null;
}
