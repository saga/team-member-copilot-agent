import { HealthBadge } from './components/HealthBadge';
import { Chat } from './components/Chat';

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>Team Member Copilot Agent</h1>
        <p className="sub">React (Vite) → Express API → @github/copilot-sdk</p>
        <HealthBadge />
      </header>
      <main>
        <Chat />
      </main>
    </div>
  );
}
