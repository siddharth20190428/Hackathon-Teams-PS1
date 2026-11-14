import { useAuth } from './auth.jsx';
import { AuthPage } from './components/AuthPage.jsx';
import { Shell } from './Shell.jsx';
import { Spinner } from './components/ui.jsx';

export default function App() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div className="splash" role="status" aria-label="Loading">
        <Spinner />
      </div>
    );
  }
  return status === 'ready' ? <Shell /> : <AuthPage />;
}
