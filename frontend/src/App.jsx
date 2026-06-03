import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Dashboard from './pages/Dashboard';
import Players from './pages/Players';
import PlayerProfile from './pages/PlayerProfile';
import Matches from './pages/Matches';
import MatchCreation from './pages/MatchCreation';
import TeamBuilder from './pages/TeamBuilder';
import Gameday from './pages/Gameday';

function App() {
  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-grow container mx-auto px-4 py-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/players" element={<Players />} />
            <Route path="/players/:id" element={<PlayerProfile />} />
            <Route path="/gameday" element={<Gameday />} />
            <Route path="/team-builder" element={<TeamBuilder />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/matches/new" element={<MatchCreation />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
