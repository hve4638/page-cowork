import { Well } from "@/components";
import { Column } from "@/components/layout";

export function MainContent() {
    return (
        <Column
            className='p-[0.5em]'
        >
            <div>Content</div>
            <Well>h</Well>
        </Column>
    )
}