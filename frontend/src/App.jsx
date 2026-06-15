import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import Dashboard from './pages/Dashboard';
import Players from './pages/Players';
import PlayerProfile from './pages/PlayerProfile';
import Matches from './pages/Matches';
import MatchCreation from './pages/MatchCreation';
import TeamBuilder from './pages/TeamBuilder';
import Gameday from './pages/Gameday';

// v2 (SPEC_15) pages — additive; do not affect v1 routes above.
import V2Leaderboard from './pages/v2/Leaderboard';
import V2PlayerProfile from './pages/v2/PlayerProfile';
import V2AdminRating from './pages/v2/AdminRating';
import V2Builder from './pages/v2/Builder';
import V2Survey from './pages/v2/Survey';
import V2Results from './pages/v2/Results';

// SPEC_16 — player-facing magic-link flow.
import V2Redeem from './pages/v2/Redeem';
import V2MyCard from './pages/v2/MyCard';
import V2RateTeammates from './pages/v2/RateTeammates';

// SPEC_17 minimum slice — events / signup
import V2EventRegister from './pages/v2/EventRegister';
import V2AdminEvents from './pages/v2/AdminEvents';

function App() {
  return (
    <Router>
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-grow container mx-auto px-4 py-8">
          <Routes>
            {/* Root → v2 "Last Week" results, the player home (per the landing
                redesign). v1 Dashboard hits dead v1 endpoints; v1 routes stay
                mounted below for safety but are not surfaced (see Navbar). */}
            <Route path="/" element={<Navigate to="/v2/results" replace />} />
            <Route path="/players" element={<Players />} />
            <Route path="/players/:id" element={<PlayerProfile />} />
            <Route path="/gameday" element={<Gameday />} />
            <Route path="/team-builder" element={<TeamBuilder />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/matches/new" element={<MatchCreation />} />

            {/* v2 routes */}
            <Route path="/v2"                       element={<Navigate to="/v2/results" replace />} />
            <Route path="/v2/results"               element={<V2Results />} />
            <Route path="/v2/leaderboard"           element={<V2Leaderboard />} />
            <Route path="/v2/profile/:person_id"    element={<V2PlayerProfile />} />
            <Route path="/v2/admin-rating"          element={<V2AdminRating />} />
            <Route path="/v2/builder"               element={<V2Builder />} />
            <Route path="/v2/survey/:match_id"      element={<V2Survey />} />

            {/* SPEC_16 — player-facing (session-authed via magic link) */}
            <Route path="/r/:token"                 element={<V2Redeem />} />
            <Route path="/v2/me"                    element={<V2MyCard />} />
            <Route path="/v2/me/rate"               element={<V2RateTeammates />} />

            {/* SPEC_17 minimum slice — events */}
            <Route path="/v2/e/:share_token"        element={<V2EventRegister />} />
            <Route path="/v2/admin/events"          element={<V2AdminEvents />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
