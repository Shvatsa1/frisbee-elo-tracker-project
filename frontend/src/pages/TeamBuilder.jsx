import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';

export default function TeamBuilder() {
  const navigate = useNavigate();
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [numTeams, setNumTeams] = useState(2);
  const [generatedTeams, setGeneratedTeams] = useState(null);

  useEffect(() => {
    api.get('/players')
      .then(res => {
        setPlayers(res.data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, []);

  const handlePlayerToggle = (playerId) => {
    setSelectedPlayers(prev => 
      prev.includes(playerId) 
        ? prev.filter(id => id !== playerId) 
        : [...prev, playerId]
    );
  };

  const handleBalance = () => {
    if (selectedPlayers.length < numTeams) {
      alert(`Please select at least ${numTeams} players.`);
      return;
    }

    // Get full player objects for selected IDs and sort by Elo descending
    const selected = players
      .filter(p => selectedPlayers.includes(p.player_id))
      .sort((a, b) => b.current_elo - a.current_elo);

    const teams = Array.from({ length: numTeams }, () => []);
    const teamElos = Array(numTeams).fill(0);

    // Greedy distribution
    for (const player of selected) {
      // Find team with lowest current total Elo
      let minIndex = 0;
      let minElo = teamElos[0];
      for (let i = 1; i < numTeams; i++) {
        if (teamElos[i] < minElo) {
          minElo = teamElos[i];
          minIndex = i;
        }
      }

      teams[minIndex].push(player);
      teamElos[minIndex] += player.current_elo;
    }

    setGeneratedTeams({ teams, teamElos });
  };

  const createMatchFromTeams = () => {
    if (!generatedTeams || generatedTeams.teams.length < 2) return;
    // We navigate to /matches/new. Passing state via React Router
    // Wait, MatchCreation expects standard state, we can't easily pass it without modifying MatchCreation to read location.state.
    // For now, let's just instruct them it's generated. Or let's modify MatchCreation to read state!
    // We will do that next.
    navigate('/matches/new', { 
      state: { 
        teamA: generatedTeams.teams[0].map(p => p.player_id), 
        teamB: generatedTeams.teams[1].map(p => p.player_id) 
      }
    });
  };

  if (loading) return <div className="text-center py-10">Loading players...</div>;

  const filteredPlayers = players.filter(p => p.player_name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Team Builder</h1>
          <p className="text-slate-400">Select players and automatically generate balanced teams based on Elo.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Player Selection */}
        <div className="lg:col-span-1 glass-panel p-6 flex flex-col h-[600px]">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-bold">Roster</h2>
            <span className="text-sm font-medium bg-primary/20 text-primary px-2 py-1 rounded">
              {selectedPlayers.length} Selected
            </span>
          </div>
          
          <input 
            type="text" 
            placeholder="Search players..." 
            className="input-field mb-4"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />

          <div className="flex-grow overflow-y-auto space-y-2 pr-2">
            {filteredPlayers.map(p => {
              const isSelected = selectedPlayers.includes(p.player_id);
              return (
                <label key={p.player_id} className={`flex items-center p-3 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-primary/20 border border-primary/50' : 'bg-white/5 hover:bg-white/10 border border-transparent'}`}>
                  <input 
                    type="checkbox" 
                    className="hidden"
                    checked={isSelected}
                    onChange={() => handlePlayerToggle(p.player_id)}
                  />
                  <div className="flex-grow flex justify-between items-center">
                    <span className="font-medium">{p.player_name}</span>
                    <span className="text-xs text-slate-400">{Math.round(p.current_elo)}</span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Right Column: Configuration & Results */}
        <div className="lg:col-span-2 space-y-6">
          <div className="glass-panel p-6 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <label className="font-medium text-slate-300">Number of Teams:</label>
              <select 
                value={numTeams}
                onChange={(e) => setNumTeams(parseInt(e.target.value))}
                className="bg-slate-900 border border-white/10 text-white rounded-lg px-3 py-2 outline-none focus:border-primary"
              >
                {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} Teams</option>)}
              </select>
            </div>
            <button onClick={handleBalance} className="btn-primary px-8">
              Generate Balanced Teams
            </button>
          </div>

          {generatedTeams && (
            <div className="glass-panel p-6 space-y-6 animate-in slide-in-from-bottom-4 duration-500">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold">Generated Teams</h2>
                {generatedTeams.teams.length === 2 && (
                  <button onClick={createMatchFromTeams} className="btn-secondary text-sm">
                    Record Match with Teams A & B
                  </button>
                )}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {generatedTeams.teams.map((team, idx) => {
                  const avgElo = team.length > 0 ? generatedTeams.teamElos[idx] / team.length : 0;
                  return (
                    <div key={idx} className="bg-white/5 rounded-xl border border-white/10 p-4">
                      <div className="flex justify-between items-center mb-4 border-b border-white/10 pb-2">
                        <h3 className="font-bold text-lg text-secondary">Team {String.fromCharCode(65 + idx)}</h3>
                        <div className="text-sm text-slate-400">
                          Avg Elo: <span className="font-bold text-white">{Math.round(avgElo)}</span>
                        </div>
                      </div>
                      <div className="space-y-2">
                        {team.map(p => (
                          <div key={p.player_id} className="flex justify-between items-center text-sm">
                            <span>{p.player_name}</span>
                            <span className="text-slate-400">{Math.round(p.current_elo)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
