import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../utils/api';

export default function MatchCreation() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialTeamA = location.state?.teamA || [];
  const initialTeamB = location.state?.teamB || [];
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  const [formData, setFormData] = useState({
    match_date: new Date().toISOString().split('T')[0],
    location: '',
    team_a_score: '',
    team_b_score: '',
  });
  
  const [teamA, setTeamA] = useState(initialTeamA);
  const [teamB, setTeamB] = useState(initialTeamB);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/players')
      .then(res => {
        setPlayers(res.data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load players');
        setLoading(false);
      });
  }, []);

  const handlePlayerToggle = (playerId, team) => {
    if (team === 'A') {
      setTeamA(prev => prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]);
      setTeamB(prev => prev.filter(id => id !== playerId));
    } else {
      setTeamB(prev => prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]);
      setTeamA(prev => prev.filter(id => id !== playerId));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (teamA.length === 0 || teamB.length === 0) {
      setError('Both teams must have at least one player.');
      return;
    }
    
    if (formData.team_a_score === formData.team_b_score) {
      setError('Draws are not currently supported.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/matches', {
        ...formData,
        team_a_score: parseInt(formData.team_a_score),
        team_b_score: parseInt(formData.team_b_score),
        team_a_players: teamA,
        team_b_players: teamB
      });
      navigate('/matches');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create match');
      setSubmitting(false);
    }
  };

  if (loading) return <div className="text-center py-10">Loading...</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500">
      <h1 className="text-3xl font-bold tracking-tight">Record Match</h1>
      
      {error && <div className="bg-red-500/20 border border-red-500/50 text-red-200 px-4 py-3 rounded-xl">{error}</div>}

      <form onSubmit={handleSubmit} className="space-y-8">
        
        {/* Match Details */}
        <div className="glass-panel p-6 space-y-4">
          <h2 className="text-xl font-semibold mb-4">Match Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Date</label>
              <input 
                type="date" 
                required
                className="input-field"
                value={formData.match_date}
                onChange={e => setFormData({...formData, match_date: e.target.value})}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-400 mb-1">Location</label>
              <input 
                type="text" 
                className="input-field"
                placeholder="e.g. Shivaji Park"
                value={formData.location}
                onChange={e => setFormData({...formData, location: e.target.value})}
              />
            </div>
          </div>
        </div>

        {/* Player Search */}
        <div className="glass-panel p-4">
          <input 
            type="text" 
            placeholder="Search players..." 
            className="input-field"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Teams and Scores */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Team A */}
          <div className="glass-panel p-6 space-y-6 border-t-4 border-t-secondary/50">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Team A</h2>
              <div className="w-24">
                <input 
                  type="number" 
                  required
                  min="0"
                  placeholder="Score"
                  className="input-field text-center font-bold text-xl"
                  value={formData.team_a_score}
                  onChange={e => setFormData({...formData, team_a_score: e.target.value})}
                />
              </div>
            </div>
            
            <div>
              <h3 className="text-sm font-medium text-slate-400 mb-3">Select Players ({teamA.length})</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {players.filter(p => p.player_name.toLowerCase().includes(searchTerm.toLowerCase())).map(p => (
                  <label key={`A-${p.player_id}`} className={`flex items-center p-3 rounded-lg cursor-pointer transition-colors ${teamA.includes(p.player_id) ? 'bg-secondary/20 border border-secondary/50' : 'bg-white/5 hover:bg-white/10 border border-transparent'}`}>
                    <input 
                      type="checkbox" 
                      className="hidden"
                      checked={teamA.includes(p.player_id)}
                      onChange={() => handlePlayerToggle(p.player_id, 'A')}
                    />
                    <div className="flex-grow flex justify-between items-center">
                      <span className="font-medium">{p.player_name}</span>
                      <span className="text-xs text-slate-400">{Math.round(p.current_elo)} Elo</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Team B */}
          <div className="glass-panel p-6 space-y-6 border-t-4 border-t-primary/50">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Team B</h2>
              <div className="w-24">
                <input 
                  type="number" 
                  required
                  min="0"
                  placeholder="Score"
                  className="input-field text-center font-bold text-xl"
                  value={formData.team_b_score}
                  onChange={e => setFormData({...formData, team_b_score: e.target.value})}
                />
              </div>
            </div>
            
            <div>
              <h3 className="text-sm font-medium text-slate-400 mb-3">Select Players ({teamB.length})</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {players.filter(p => p.player_name.toLowerCase().includes(searchTerm.toLowerCase())).map(p => (
                  <label key={`B-${p.player_id}`} className={`flex items-center p-3 rounded-lg cursor-pointer transition-colors ${teamB.includes(p.player_id) ? 'bg-primary/20 border border-primary/50' : 'bg-white/5 hover:bg-white/10 border border-transparent'}`}>
                    <input 
                      type="checkbox" 
                      className="hidden"
                      checked={teamB.includes(p.player_id)}
                      onChange={() => handlePlayerToggle(p.player_id, 'B')}
                    />
                    <div className="flex-grow flex justify-between items-center">
                      <span className="font-medium">{p.player_name}</span>
                      <span className="text-xs text-slate-400">{Math.round(p.current_elo)} Elo</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

        </div>

        <div className="flex justify-end pt-4">
          <button 
            type="submit" 
            disabled={submitting}
            className="btn-primary text-lg px-8 py-3 w-full md:w-auto"
          >
            {submitting ? 'Calculating & Saving...' : 'Save Match'}
          </button>
        </div>
      </form>
    </div>
  );
}
