import { Outlet, Route, Routes } from 'react-router';
import { Friends } from './pages/Friends.js';
import { GameDetail } from './pages/GameDetail.js';
import { HandReplay } from './pages/HandReplay.js';
import { History } from './pages/History.js';
import { Lobby } from './pages/Lobby.js';
import { Login } from './pages/Login.js';
import { Profile } from './pages/Profile.js';
import { Results } from './pages/Results.js';
import { Settlement } from './pages/Settlement.js';
import { Stats } from './pages/Stats.js';
import { TablePage } from './pages/TablePage.js';
import { Wallet } from './pages/Wallet.js';
import { Shell } from './ui/Shell.js';

function ShellLayout() {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<ShellLayout />}>
        <Route path="/" element={<Lobby />} />
        <Route path="/friends" element={<Friends />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/games/:id" element={<GameDetail />} />
        <Route path="/table/:id" element={<TablePage />} />
        <Route path="/history" element={<History />} />
        <Route path="/history/:handId" element={<HandReplay />} />
        <Route path="/wallet" element={<Wallet />} />
        <Route path="/settle/:gameId" element={<Settlement />} />
        <Route path="/stats/:userId" element={<Stats />} />
        <Route path="/results/:gameId" element={<Results />} />
      </Route>
    </Routes>
  );
}
