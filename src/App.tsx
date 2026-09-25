import { HealthBadge } from './components/HealthBadge';
import { TeamChat } from './components/TeamChat';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Team Member Copilot Agent</h1>
          <p className="sub">Member → Conversation → Member Runtime → Copilot Session</p>
        </div>
        <HealthBadge />
      </header>
      <main>
        <TeamChat />
      </main>
    </div>
  );
}
