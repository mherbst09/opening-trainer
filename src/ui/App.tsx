import { useEffect } from 'react';
import { AppDataProvider } from './data';
import { useRoute } from './router';
import { Home } from './routes/Home';
import { Learn } from './routes/Learn';
import { Quiz } from './routes/Quiz';
import { Setup } from './routes/Setup';
import { Import } from './routes/Import';
import { Settings, SyncStatusText } from './routes/Settings';
import { startSync, useSyncStatus } from '../sync/instance';
import { ErrorBoundary } from './components/ErrorBoundary';

const CHIP_ICON: Record<string, string> = {
  disabled: '⚙', 'needs-login': '☁', idle: '✓', syncing: '⟳', offline: '⚡', error: '!',
};

function SyncChip() {
  const s = useSyncStatus();
  return (
    <a className={`btn small ghost sync-chip state-${s.state}`} href="#/settings" aria-label="Settings and sync status">
      <span aria-hidden>{CHIP_ICON[s.state]}</span>
      <span className="chip-text"><SyncStatusText short /></span>
    </a>
  );
}

function Shell() {
  const route = useRoute();
  const [section, id] = route.path;
  let page;
  if (section === 'learn' && id) page = <Learn key={id} openingId={id} />;
  else if (section === 'quiz') page = <Quiz key={route.params.toString()} params={route.params} />;
  else if (section === 'setup') page = <Setup key={route.params.toString()} params={route.params} />;
  else if (section === 'import') page = <Import />;
  else if (section === 'settings') page = <Settings />;
  else page = <Home />;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">♞ Openings</a>
        <nav>
          <a className="btn small ghost" href="#/setup">Quiz setup</a>
          <SyncChip />
        </nav>
      </header>
      <main>
        <ErrorBoundary key={section ?? 'home'}>{page}</ErrorBoundary>
      </main>
    </div>
  );
}

export function App() {
  useEffect(() => {
    void startSync();
  }, []);
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}
