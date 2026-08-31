import { Align, Row } from "@/components/layout";
import { cn } from "@/lib/utils";

export function Header() {
    return (
        <Row
            className={
                cn('col-span-full bg-bg border-b border-border pl-[0.5em]',
                    'undraggable'
                )
            }
            columnAlign={Align.Center}
        >
            <span>Front Template</span>
        </Row>
    );
}