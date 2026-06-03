import { useState, useEffect } from 'react';
import { Users, LayoutDashboard, Shield, Sword, CheckCircle, RefreshCcw, Save } from 'lucide-react';
import api from '../utils/api';

export default function Gameday() {
  const [step, setStep] = useState(0); // 0: Roster, 1: Draft, 2: Active
  
  // Players data
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Step 0: Roster State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPlayers, setSelectedPlayers] = useState([]);
  const [numTeams, setNumTeams] = useState(4);
  
  // Step 1 & 2: Teams & Matches State
  const [teams, setTeams] = useState([]); // [{ name: 'Team A', players: [...] }]
  const [matches, setMatches] = useState([]); // [{ id, teamAIdx, teamBIdx, teamAScore, teamBScore, submitted, expectedA, expectedB }]

  // Load state from localStorage on mount
  useEffect(() => {
    const savedState = localStorage.getItem('active_gameday');
    if (savedState) {
      try {
        const parsed = JSON.parse(savedState);
        setStep(parsed.step);
        setSelectedPlayers(parsed.selectedPlayers || []);
        setNumTeams(parsed.numTeams || 4);
        setTeams(parsed.teams || []);
        setMatches(parsed.matches || []);
      } catch (e) {
        console.error("Failed to parse saved gameday state", e);
      }
    }
    
    // Fetch latest players
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

  // Save state whenever relevant things change
  useEffect(() => {
    if (loading) return; // Don't save initial unmounted state
    const stateToSave = { step, selectedPlayers, numTeams, teams, matches };
    localStorage.setItem('active_gameday', JSON.stringify(stateToSave));
  }, [step, selectedPlayers, numTeams, teams, matches, loading]);

  // --- Step 0 Actions ---
  const handlePlayerToggle = (playerId) => {
    setSelectedPlayers(prev => 
      prev.includes(playerId) 
        ? prev.filter(id => id !== playerId) 
        : [...prev, playerId]
    );
  };

  const handleDraft = () => {
    if (selectedPlayers.length < numTeams) {
      alert(`Please select at least ${numTeams} players.`);
      return;
    }

    // Auto-draft Logic (Greedy Elo balancing)
    const selected = players
      .filter(p => selectedPlayers.includes(p.player_id))
      .sort((a, b) => b.current_elo - a.current_elo);

    const generatedTeams = Array.from({ length: numTeams }, () => []);
    const teamElos = Array(numTeams).fill(0);

    for (const player of selected) {
      let minIndex = 0;
      let minElo = teamElos[0];
      for (let i = 1; i < numTeams; i++) {
        if (teamElos[i] < minElo) {
          minElo = teamElos[i];
          minIndex = i;
        }
      }
      generatedTeams[minIndex].push(player);
      teamElos[minIndex] += player.current_elo;
    }

    // Format teams
    const formattedTeams = generatedTeams.map((teamPlayers, idx) => ({
      name: `Team ${String.fromCharCode(65 + idx)}`, // Team A, Team B, etc.
      players: teamPlayers,
      avgElo: teamPlayers.length > 0 ? teamElos[idx] / teamPlayers.length : 0
    }));

    setTeams(formattedTeams);
    setStep(1);
  };

  // --- Step 1 Actions ---
  const handleTeamNameChange = (teamIdx, newName) => {
    setTeams(prev => {
      const updated = [...prev];
      updated[teamIdx].name = newName;
      return updated;
    });
  };

  const handleMovePlayer = (playerId, fromTeamIdx, toTeamIdx) => {
    setTeams(prev => {
      const updated = [...prev];
      const fromTeam = updated[fromTeamIdx];
      const toTeam = updated[toTeamIdx];
      
      const playerIndex = fromTeam.players.findIndex(p => p.player_id === playerId);
      if (playerIndex > -1) {
        const [player] = fromTeam.players.splice(playerIndex, 1);
        toTeam.players.push(player);
        
        // Recalculate average Elos
        fromTeam.avgElo = fromTeam.players.length > 0 
          ? fromTeam.players.reduce((sum, p) => sum + p.current_elo, 0) / fromTeam.players.length 
          : 0;
        toTeam.avgElo = toTeam.players.length > 0 
          ? toTeam.players.reduce((sum, p) => sum + p.current_elo, 0) / toTeam.players.length 
          : 0;
      }
      return updated;
    });
  };

  const handleLockTeams = () => {
    // Generate Round Robin matches
    const newMatches = [];
    let matchIdCount = 1;
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        newMatches.push({
          id: matchIdCount++,
          teamAIdx: i,
          teamBIdx: j,
          teamAScore: '',
          teamBScore: '',
          submitted: false
        });
      }
    }
    setMatches(newMatches);
    setStep(2);
  };

  // --- Step 2 Actions ---
  const handleScoreChange = (matchId, team, value) => {
    setMatches(prev => prev.map(m => {
      if (m.id === matchId) {
        return { ...m, [team === 'A' ? 'teamAScore' : 'teamBScore']: value };
      }
      return m;
    }));
  };

  const handleSubmitMatch = async (match) => {
    if (match.teamAScore === '' || match.teamBScore === '') {
      alert("Please enter scores for both teams");
      return;
    }
    
    const teamA = teams[match.teamAIdx];
    const teamB = teams[match.teamBIdx];
    
    try {
      const res = await api.post('/matches', {
        match_date: new Date().toISOString().split('T')[0],
        location: 'Pickup Wednesday', // Default name
        team_a_score: parseInt(match.teamAScore),
        team_b_score: parseInt(match.teamBScore),
        team_a_players: teamA.players.map(p => p.player_id),
        team_b_players: teamB.players.map(p => p.player_id),
        team_a_name: teamA.name,
        team_b_name: teamB.name
      });
      
      // Mark as submitted
      setMatches(prev => prev.map(m => 
        m.id === match.id ? { ...m, submitted: true } : m
      ));
      
      alert(`Match submitted successfully! Match ID: ${res.data.matchId}`);
    } catch (err) {
      alert("Error submitting match: " + (err.response?.data?.error || err.message));
    }
  };

  const handleEndSession = () => {
    if (window.confirm("Are you sure you want to end this session? This will clear the active teams and matchups.")) {
      localStorage.removeItem('active_gameday');
      setStep(0);
      setSelectedPlayers([]);
      setTeams([]);
      setMatches([]);
    }
  };


  if (loading) return <div className="text-center py-20 text-slate-400">Loading Wizard...</div>;

  const filteredPlayers = players.filter(p => p.player_name.toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500 pb-20">
      
      {/* Header */}
      <div className="glass-panel p-6 flex flex-col md:flex-row justify-between items-start md:items-center border-primary/20">
        <div>
          <h1 className="text-3xl font-black tracking-tight mb-2 flex items-center">
            <LayoutDashboard className="w-8 h-8 mr-3 text-primary" />
            Gameday Wizard
          </h1>
          <p className="text-slate-400">Create locked teams and quickly record multiple matches for a pickup session.</p>
        </div>
        
        {/* Progress Indicator */}
        <div className="flex space-x-2 mt-4 md:mt-0">
          <div className={`px-4 py-1.5 rounded-full text-xs font-bold ${step === 0 ? 'bg-primary text-white' : 'bg-white/5 text-slate-500'}`}>1. Roster</div>
          <div className={`px-4 py-1.5 rounded-full text-xs font-bold ${step === 1 ? 'bg-primary text-white' : 'bg-white/5 text-slate-500'}`}>2. Draft</div>
          <div className={`px-4 py-1.5 rounded-full text-xs font-bold ${step === 2 ? 'bg-primary text-white' : 'bg-white/5 text-slate-500'}`}>3. Matches</div>
        </div>
      </div>

      {/* STEP 0: ROSTER */}
      {step === 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in slide-in-from-right-8">
          
          <div className="lg:col-span-2 glass-panel p-6 flex flex-col h-[600px]">
             <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold flex items-center"><Users className="w-5 h-5 mr-2 text-primary"/> Select Players</h2>
              <input 
                type="text" 
                placeholder="Search..." 
                className="input-field w-48 py-1.5 px-3 text-sm"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 overflow-y-auto pr-2 custom-scrollbar">
              {filteredPlayers.map(p => {
                const isSelected = selectedPlayers.includes(p.player_id);
                return (
                  <label key={p.player_id} className={`flex items-center p-3 rounded-lg cursor-pointer transition-colors ${isSelected ? 'bg-primary/20 border border-primary/50' : 'bg-slate-900/40 hover:bg-white/10 border border-transparent'}`}>
                    <input 
                      type="checkbox" 
                      className="hidden"
                      checked={isSelected}
                      onChange={() => handlePlayerToggle(p.player_id)}
                    />
                    <div className="flex-grow flex justify-between items-center">
                      <span className={`font-medium ${isSelected ? 'text-white' : 'text-slate-300'}`}>{p.player_name}</span>
                      <span className="text-xs text-slate-500">{Math.round(p.current_elo)}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
          
          <div className="lg:col-span-1 space-y-6">
            <div className="glass-panel p-6">
              <div className="text-center mb-6">
                <div className="text-6xl font-black text-primary mb-2">{selectedPlayers.length}</div>
                <div className="text-sm font-bold text-slate-400 uppercase tracking-widest">Players Selected</div>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-2">Number of Teams to Form</label>
                  <select 
                    value={numTeams}
                    onChange={(e) => setNumTeams(parseInt(e.target.value))}
                    className="w-full bg-slate-900 border border-white/10 text-white rounded-xl px-4 py-3 outline-none focus:border-primary"
                  >
                    {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} Teams</option>)}
                  </select>
                </div>
                
                <button 
                  onClick={handleDraft}
                  disabled={selectedPlayers.length < numTeams}
                  className="w-full btn-primary py-4 text-lg font-bold flex justify-center items-center disabled:opacity-50"
                >
                  <RefreshCcw className="w-5 h-5 mr-2" /> Auto-Draft Teams
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* STEP 1: DRAFT REVIEW */}
      {step === 1 && (
        <div className="space-y-6 animate-in slide-in-from-right-8">
           <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold">Review Generated Teams</h2>
            <div className="flex space-x-3">
              <button onClick={() => setStep(0)} className="btn-secondary">Back to Roster</button>
              <button onClick={handleLockTeams} className="btn-primary flex items-center">
                <Shield className="w-4 h-4 mr-2" /> Lock Teams & Start Session
              </button>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {teams.map((team, idx) => (
              <div key={idx} className="glass-panel p-0 overflow-hidden flex flex-col">
                <div className="bg-black/30 p-4 border-b border-white/5 flex justify-between items-center">
                  <input
                    type="text"
                    value={team.name}
                    onChange={(e) => handleTeamNameChange(idx, e.target.value)}
                    className="font-black text-lg text-white bg-transparent border-b border-transparent focus:border-primary focus:outline-none w-3/5"
                  />
                  <div className="text-xs font-bold text-slate-400 uppercase">Avg Elo: <span className="text-secondary">{Math.round(team.avgElo)}</span></div>
                </div>
                <div className="p-4 space-y-2 flex-grow">
                  {team.players.map(p => (
                    <div key={p.player_id} className="flex justify-between items-center text-sm group">
                      <span className="text-slate-300 font-medium">{p.player_name}</span>
                      <div className="flex items-center space-x-2">
                        <select
                          value={idx}
                          onChange={(e) => handleMovePlayer(p.player_id, idx, parseInt(e.target.value))}
                          className="text-xs bg-slate-900 border border-white/10 rounded px-1 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity outline-none text-slate-300"
                        >
                          {teams.map((t, tIdx) => (
                            <option key={tIdx} value={tIdx}>Move to {t.name}</option>
                          ))}
                        </select>
                        <span className="text-slate-600 text-xs w-8 text-right">{Math.round(p.current_elo)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bg-black/20 p-2 text-center text-xs text-slate-500 font-medium border-t border-white/5">
                  {team.players.length} Players
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* STEP 2: ACTIVE MATCHES */}
      {step === 2 && (
        <div className="space-y-6 animate-in slide-in-from-bottom-8">
          <div className="flex justify-between items-center bg-primary/10 border border-primary/20 p-4 rounded-xl">
            <div>
              <h2 className="text-lg font-bold text-primary flex items-center"><Shield className="w-5 h-5 mr-2" /> Session Active</h2>
              <p className="text-sm text-slate-400">Teams are locked. Record scores below.</p>
            </div>
            <button onClick={handleEndSession} className="btn-secondary border-red-500/30 text-red-400 hover:bg-red-500/10">
              End Session
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {matches.map((match) => {
              const teamA = teams[match.teamAIdx];
              const teamB = teams[match.teamBIdx];
              const isSubmitted = match.submitted;

              return (
                <div key={match.id} className={`glass-panel p-6 border-l-4 transition-all ${isSubmitted ? 'border-l-secondary bg-secondary/5' : 'border-l-primary hover:border-l-blue-400'}`}>
                  
                  <div className="flex justify-between items-center mb-6">
                    <span className="text-xs font-black uppercase tracking-widest text-slate-500">Match #{match.id}</span>
                    {isSubmitted ? (
                       <span className="flex items-center text-secondary text-xs font-bold uppercase tracking-wider bg-secondary/10 px-2 py-1 rounded">
                         <CheckCircle className="w-3 h-3 mr-1" /> Logged
                       </span>
                    ) : (
                       <span className="flex items-center text-amber-500 text-xs font-bold uppercase tracking-wider">
                         Pending
                       </span>
                    )}
                  </div>
                  
                  <div className="flex items-center justify-between space-x-4 mb-6">
                    {/* Team A */}
                    <div className="flex-1 text-center">
                      <div className="font-black text-xl mb-1">{teamA.name}</div>
                      <div className="text-xs text-slate-500 mb-3">Avg: {Math.round(teamA.avgElo)}</div>
                      <input 
                        type="number" 
                        min="0"
                        placeholder="0"
                        disabled={isSubmitted}
                        value={match.teamAScore}
                        onChange={(e) => handleScoreChange(match.id, 'A', e.target.value)}
                        className="w-20 text-center text-3xl font-black bg-black/40 border border-white/10 rounded-xl py-3 focus:border-primary focus:ring-1 focus:ring-primary outline-none disabled:opacity-50"
                      />
                    </div>
                    
                    <div className="shrink-0 flex flex-col items-center justify-center pt-8">
                       <Sword className="w-6 h-6 text-slate-600 mb-2" />
                    </div>
                    
                    {/* Team B */}
                    <div className="flex-1 text-center">
                      <div className="font-black text-xl mb-1">{teamB.name}</div>
                      <div className="text-xs text-slate-500 mb-3">Avg: {Math.round(teamB.avgElo)}</div>
                      <input 
                        type="number" 
                        min="0"
                        placeholder="0"
                        disabled={isSubmitted}
                        value={match.teamBScore}
                        onChange={(e) => handleScoreChange(match.id, 'B', e.target.value)}
                        className="w-20 text-center text-3xl font-black bg-black/40 border border-white/10 rounded-xl py-3 focus:border-primary focus:ring-1 focus:ring-primary outline-none disabled:opacity-50"
                      />
                    </div>
                  </div>
                  
                  {!isSubmitted && (
                    <button 
                      onClick={() => handleSubmitMatch(match)}
                      className="w-full btn-primary py-3 font-bold flex items-center justify-center"
                    >
                      <Save className="w-4 h-4 mr-2" /> Submit Final Score
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
