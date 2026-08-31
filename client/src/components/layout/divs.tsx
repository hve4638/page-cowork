import StyledDiv, {StyledDivTags} from './StyledDiv';
export function Flex(tags:StyledDivTags) {
    return (
        <StyledDiv
            baseClassName='flex flex-1'
            tags={tags}
        />
    )
}

export function NoFlex(tags:StyledDivTags) {
    return (
        <StyledDiv
            baseClassName='flex flex-none'
            tags={tags}
        />
    )
}
export function Center(tags:StyledDivTags) {
    return (
        <StyledDiv
            baseClassName='flex items-center justify-center'
            tags={tags}
        />
    )
}