import { Grid } from '@/components/layout';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { Header } from './Header';

export function Home() {
    return (
        <Grid
            className='w-full h-full'
            rows='2.5em 1fr'
            columns='200px 1fr'
        >
            <Header />
            <Sidebar />
            <MainContent />
        </Grid>
    );
}
