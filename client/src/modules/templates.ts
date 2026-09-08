// 템플릿 복제. 템플릿은 kind='template' 인 서브페이지이고, 본문·속성을 보통 페이지처럼 편집한다 (사용자 결정 2026-09-07).
// 매크로의 "템플릿 넣기" 가 이 함수로 템플릿 페이지의 블럭·속성을 새 id 로 복제하면서 {{변수}} 를 치환한다.
// 치환 규칙: 블럭 text, 탭 이름, text 형 속성 값 안의 {{이름}} 을 변수 값으로 바꾼다. 값이 목록이면 ', ' 로 잇는다. 속성은 새로 만든 페이지에만 들어간다 (macros.ts).
// 탭 이름이 목록 변수 하나({{팀원}})면 원소마다 탭이 하나씩 생기고 그 슬롯의 자식도 탭마다 복제된다. 목록이 비면 그 탭은 빠지고, 탭이 하나도 안 남으면 탭 블럭째 빠진다.
import { readTable, rid } from '@/sync/store';
import type { BlockRow, SubpageRow } from './BlockDoc';
import { propId, type PagePropRow } from './props';

export type VarValue = string | number | null | string[];
export type Vars = Record<string, VarValue>;

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const str = (v: VarValue | undefined) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));
// 문자열 안의 {{이름}} 치환. 문자열 전체가 변수 하나면 원래 형(숫자·목록)을 그대로 돌려준다 — 날짜 속성 값 등 문자열이 아닌 값을 넘기기 위해서다.
// 없는 변수는 {{이름}} 그대로 둔다 (변수 없이 템플릿만 꽂았을 때 자리가 보이도록).
export function subst(s: string, vars: Vars): VarValue {
    const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(s);
    if (whole) return whole[1] in vars ? vars[whole[1]] : s;
    return s.replace(VAR_RE, (m, name: string) => (name in vars ? str(vars[name]) : m));
}
const substText = (s: string, vars: Vars) => str(subst(s, vars));

export const templatePages = (pages: SubpageRow[]) => pages.filter(p => p.kind === 'template').sort((a, b) => a.pos - b.pos);
export const MEETING_TEMPLATE_ID = 'tpl-meeting'; // 서버가 심는 내장 회의록 (server/src/db.ts)
// 템플릿 찾기: id 가 먼저, 없으면 이름(제목). 회의 보드처럼 특정 템플릿을 가리킬 때는 id 를, 사용자 매크로의 단계에서는 이름을 쓴다
export const findTemplate = (key: string) => {
    const all = templatePages(readTable('subpages') as SubpageRow[]);
    return all.find(p => p.id === key) ?? all.find(p => p.title === key);
};
// 템플릿 복제 (사이드바). 사본은 보통 템플릿이고 {{변수}} 는 그대로 남는다 (없는 변수는 치환하지 않으므로). 내장 회의록도 복제해 고칠 수 있다.
export function duplicateTemplate(src: SubpageRow, pages: SubpageRow[]): { page: SubpageRow; blocks: BlockRow[]; props: PagePropRow[] } {
    const page: SubpageRow = { id: rid(16), title: `${src.title} 사본`, pos: Math.max(0, ...pages.map(p => p.pos)) + 1, kind: 'template' };
    return { page, ...instantiate(src.id, {}, page.id, 0) };
}

// 템플릿 페이지의 행들을 docId 문서용으로 복제한다. 최상위 블럭의 pos 는 fromPos 다음부터 1 씩, 자식은 부모 id 만 새 것으로 바꾼다.
// 속성 id 는 '<doc_id>:<key>' 라 새 문서 id 로 다시 만든다.
export function instantiate(templateId: string, vars: Vars, docId: string, fromPos: number): { blocks: BlockRow[]; props: PagePropRow[] } {
    const all = (readTable('blocks') as BlockRow[]).filter(b => b.doc_id === templateId);
    const out: BlockRow[] = [];
    // 블럭 하나와 그 자식을 복제한다. 자식은 template 의 parent_id 로 찾고 새 부모 id 를 받는다. slotMap 은 탭 확장 시 (원래 슬롯 → 새 슬롯들).
    const copy = (src: BlockRow, parent: string | null, pos: number, tab?: string): BlockRow | null => {
        const id = rid(8);
        const style = { ...src.style };
        if (tab !== undefined) style.tab = tab;
        const row: BlockRow = { ...src, id, doc_id: docId, parent_id: parent, pos, text: substText(src.text, vars), style };
        const children = all.filter(c => c.parent_id === src.id).sort((a, b) => a.pos - b.pos);
        if (src.type === 'tabs') {
            const tabs: { id: string; label: string }[] = [];
            const expanded = new Map<string, string[]>(); // 원래 슬롯 → 새 슬롯들
            for (const t of src.style?.tabs ?? []) {
                const v = subst(t.label, vars);
                const labels = Array.isArray(v) ? v : [str(v)];
                const ids = labels.map(label => { const nid = rid(4); tabs.push({ id: nid, label }); return nid; });
                expanded.set(t.id, ids);
            }
            if (!tabs.length) return null;
            row.style = { ...style, tabs };
            out.push(row);
            let p = 0;
            for (const c of children) for (const slot of expanded.get(c.style?.tab ?? '') ?? []) copy(c, id, ++p, slot);
            return row;
        }
        out.push(row);
        children.forEach((c, i) => copy(c, id, i + 1));
        return row;
    };
    let pos = fromPos;
    for (const b of all.filter(b => !b.parent_id).sort((a, b) => a.pos - b.pos)) if (copy(b, null, pos + 1)) pos += 1;
    const props = (readTable('page_props') as PagePropRow[])
        .filter(p => p.doc_id === templateId)
        .sort((a, b) => a.pos - b.pos)
        .map(p => ({ ...p, id: propId(docId, p.key), doc_id: docId, value: p.type === 'text' && typeof p.value === 'string' ? substText(p.value, vars) : p.value }));
    return { blocks: out, props };
}
