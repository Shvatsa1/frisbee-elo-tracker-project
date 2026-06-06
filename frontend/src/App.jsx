import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Dashboard from './pages/Dashboard';
import Players from './pages/Players';
import PlayerProfile from './pages/PlayerProfile';
import Matches from './pages/Matches';
import MatchCreation from './pages/MatchCreation';
import TeamBuilder from './pages/TeamBuilder';
import Gameday from './pages/Gameday';
import Login from './pages/Login';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Navigate } from 'react-router-dom';

const ProtectedRoute = ({ children }) => {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/" replace />;
  return children;
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <div className="min-h-screen flex flex-col">
          <Navbar />
          <main className="flex-grow container mx-auto px-4 py-8">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/login" element={<Login />} />
              <Route path="/players" element={<Players />} />
              <Route path="/players/:id" element={<PlayerProfile />} />
              <Route path="/matches" element={<Matches />} />
              
              <Route path="/gameday" element={<ProtectedRoute><Gameday /></ProtectedRoute>} />
              <Route path="/team-builder" element={<ProtectedRoute><TeamBuilder /></ProtectedRoute>} />
              <Route path="/matches/new" element={<ProtectedRoute><MatchCreation /></ProtectedRoute>} />
            </Routes>
          </main>
        </div>
      </Router>
    </AuthProvider>
  );
}

export default App;
