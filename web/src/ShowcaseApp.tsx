import { BrowserRouter } from 'react-router-dom';
import { ResearchPage } from './pages/ResearchPage';

export function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <ResearchPage />
    </BrowserRouter>
  );
}
