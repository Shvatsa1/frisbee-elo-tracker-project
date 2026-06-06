import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, MapPin, Zap, Pencil, Save, X, RefreshCcw, Shield } from 'lucide-react';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function Matches() {
  const [matches, setMatches] = useState([]);
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();
  
  // Edit State
  const [editingMatch, setEditingMatch] = useState(null);
  const [editTeamA, setEditTeamA] = useState([]);
  const [editTeamB, setEditTeamB] = useState([]);
  const [editScoreA, setEditScoreA] = useState('');
  const [editScoreB, setEditScoreB] = useState('');
  const [editTeamAName, setEditTeamAName] = useState('');
  const [editTeamBName, setEditTeamBName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [matchesRes, playersRes] = await Promise.all([
        api.get('/matches'),
        api.get('/players')
      ]);
      setMatches(matchesRes.data);
      setPlayers(playersRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const openEditModal = (match) => {
    setEditingMatch(match);
    setEditScoreA(match.team_a_score);
    setEditScoreB(match.team_b_score);
    setEditTeamAName(match.team_a_name || 'Team A');
    setEditTeamBName(match.team_b_name || 'Team B');
    setEditTeamA(match.players?.filter(p => p.team === 'A') || []);
    setEditTeamB(match.players?.filter(p => p.team === 'B') || []);
  };

  const closeEditModal = () => {
    setEditingMatch(null);
  };

  const handleRemovePlayer = (playerId, team) => {
    if (team === 'A') {
      setEditTeamA(prev => prev.filter(p => p.player_id !== playerId));
    } else {
      setEditTeamB(prev => prev.filter(p => p.player_id !== playerId));
    }
  };

  const handleAddPlayer = (e, team) => {
    const playerId = parseInt(e.target.value);
    if (!playerId) return;
    const player = players.find(p => p.player_id === playerId);
    if (!player) return;

    if (team === 'A') {
      setEditTeamA(prev => [...prev, { player_id: player.player_id, player_name: player.player_name, team: 'A' }]);
    } else {
      setEditTeamB(prev => [...prev, { player_id: player.player_id, player_name: player.player_name, team: 'B' }]);
    }
    e.target.value = ''; // reset select
  };

  const handleSaveEdit = async () => {
    setIsSaving(true);
    try {
      const token = localStorage.getItem('token');
      
      // 1. Update Match
      await api.put(`/admin/matches/${editingMatch.match_id}`, {
        team_a_score: parseInt(editScoreA),
        team_b_score: parseInt(editScoreB),
        team_a_name: editTeamAName,
        team_b_name: editTeamBName,
        team_a_players: editTeamA.map(p => p.player_id),
        team_b_players: editTeamB.map(p => p.player_id)
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // 2. Trigger Recalculation
      await api.post('/admin/recalculate', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // 3. Refresh Data
      await fetchData();
      closeEditModal();
      alert("Match updated and Elo recalculated successfully!");
    } catch (err) {
      alert("Error saving match: " + (err.response?.data?.error || err.message));
    } finally {
      setIsSaving(false);
    }
  };

  if (loading && matches.length === 0) return <div className="text-center py-10 text-slate-400">Loading matches...</div>;

  // Filter out players already selected in the edit modal
  const selectedPlayerIds = new Set([...editTeamA.map(p => p.player_id), ...editTeamB.map(p => p.player_id)]);
  const availablePlayers = players.filter(p => !selectedPlayerIds.has(p.player_id));

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-20">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold tracking-tight">Match History</h1>
        <Link to="/matches/new" className="btn-primary">
          Record Match
        </Link>
      </div>

      <div className="space-y-6">
        {matches.map(match => {
          const teamAWon = match.winning_team === 'A';
          const teamBWon = match.winning_team === 'B';
          const isTeamAUpset = teamAWon && match.expected_win_team_a !== null && match.expected_win_team_a < 0.35;
          const isTeamBUpset = teamBWon && match.expected_win_team_b !== null && match.expected_win_team_b < 0.35;
          const isUpset = isTeamAUpset || isTeamBUpset;

          return (
            <div key={match.match_id} className="glass-panel p-0 relative overflow-hidden flex flex-col md:flex-row border-white/10 group">
              {isUpset && (
                <>
                  <div className="md:hidden bg-red-500/90 text-white text-xs font-black tracking-widest uppercase py-1.5 flex items-center justify-center">
                    <Zap className="w-4 h-4 mr-1" fill="currentColor" /> UPSET
                  </div>
                  <div className="hidden md:flex bg-red-500/90 w-12 flex-col items-center justify-center text-white shrink-0">
                    <Zap className="w-5 h-5 mb-2" fill="currentColor" />
                    <span className="[writing-mode:vertical-lr] rotate-180 font-black tracking-widest uppercase text-sm">UPSET</span>
                  </div>
                </>
              )}

              <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 flex-grow">
                {/* Meta Info */}
                <div className="flex flex-col space-y-3 w-full md:w-1/4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-black uppercase tracking-widest text-slate-500">Match #{match.match_id}</div>
                    {isAuthenticated && (
                      <button onClick={() => openEditModal(match)} className="p-2 bg-white/5 hover:bg-white/10 rounded-lg text-slate-400 hover:text-primary transition-colors">
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <div className="flex items-center text-slate-300 text-sm font-medium">
                    <Calendar className="w-4 h-4 mr-3 text-primary" />
                    {new Date(match.match_date).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                  </div>
                  <div className="flex items-center text-slate-400 text-sm">
                    <MapPin className="w-4 h-4 mr-3 text-secondary" />
                    {match.location || 'Unknown Location'}
                  </div>
                </div>

                {/* Score and Rosters */}
                <div className="flex flex-col w-full md:w-3/4 bg-slate-900/40 rounded-2xl p-6 border border-white/10 relative">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex-1 text-center">
                      <div className={`text-2xl font-black ${teamAWon ? 'text-secondary' : 'text-slate-400'}`}>
                        {match.team_a_name || 'Team A'}
                      </div>
                      {match.team_a_avg_elo && (
                        <div className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-wider">
                          {Math.round(match.team_a_avg_elo)} Avg Elo
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center space-x-6 px-4 shrink-0">
                      <div className={`text-4xl font-black ${teamAWon ? 'text-white drop-shadow-md' : 'text-slate-600'}`}>
                        {match.team_a_score}
                      </div>
                      <div className="text-slate-300 font-bold text-xl">-</div>
                      <div className={`text-4xl font-black ${teamBWon ? 'text-white drop-shadow-md' : 'text-slate-600'}`}>
                        {match.team_b_score}
                      </div>
                    </div>
                    
                    <div className="flex-1 text-center">
                      <div className={`text-2xl font-black ${teamBWon ? 'text-secondary' : 'text-slate-400'}`}>
                        {match.team_b_name || 'Team B'}
                      </div>
                      {match.team_b_avg_elo && (
                        <div className="text-xs font-bold text-slate-400 mt-1 uppercase tracking-wider">
                          {Math.round(match.team_b_avg_elo)} Avg Elo
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex justify-between text-sm border-t border-white/10 pt-4">
                    <div className="flex-1 text-center space-y-1.5">
                      {match.players?.filter(p => p.team === 'A').map(p => (
                        <div key={p.player_id}>
                          <Link to={`/players/${p.player_id}`} className="font-medium text-slate-300 hover:text-primary transition-colors">{p.player_name}</Link>
                        </div>
                      ))}
                    </div>
                    <div className="w-16 shrink-0"></div>
                    <div className="flex-1 text-center space-y-1.5">
                      {match.players?.filter(p => p.team === 'B').map(p => (
                        <div key={p.player_id}>
                          <Link to={`/players/${p.player_id}`} className="font-medium text-slate-300 hover:text-primary transition-colors">{p.player_name}</Link>
                        </div>
                      ))}
                    </div>
                  </div>
                  
                  {/* Expected Win Bar */}
                  {(match.expected_win_team_a !== null && match.expected_win_team_b !== null) && (
                    <div className="mt-6 pt-4 border-t border-white/10">
                      <div className="flex justify-between text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">
                        <span>Expected: {Math.round(match.expected_win_team_a * 100)}%</span>
                        <span>Expected: {Math.round(match.expected_win_team_b * 100)}%</span>
                      </div>
                      <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-800">
                        <div className="bg-primary/70 h-full" style={{ width: `${match.expected_win_team_a * 100}%` }}></div>
                        <div className="bg-purple-500/70 h-full" style={{ width: `${match.expected_win_team_b * 100}%` }}></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {matches.length === 0 && !loading && (
          <div className="glass-panel p-12 text-center">
            <p className="text-slate-400 mb-4">No matches recorded yet.</p>
            <Link to="/matches/new" className="btn-primary">Create the first match</Link>
          </div>
        )}
      </div>

      {/* Edit Match Modal */}
      {editingMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0B1120] border border-white/10 rounded-2xl p-6 max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl relative">
            <button onClick={closeEditModal} className="absolute top-4 right-4 p-2 bg-white/5 hover:bg-white/10 rounded-full text-slate-400 transition-colors">
              <X className="w-5 h-5" />
            </button>
            
            <h2 className="text-2xl font-bold mb-1">Edit Match #{editingMatch.match_id}</h2>
            <p className="text-amber-500 text-xs font-bold uppercase tracking-widest mb-6">Admin Mode: Saving will trigger Elo Recalculation</p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
              
              {/* Team A Edit */}
              <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                <div className="flex justify-between items-center mb-4">
                  <input 
                    type="text" 
                    value={editTeamAName}
                    onChange={(e) => setEditTeamAName(e.target.value)}
                    className="font-bold text-lg bg-transparent border-b border-transparent hover:border-white/20 focus:border-primary outline-none transition-colors w-2/3"
                    placeholder="Team A Name"
                  />
                  <input 
                    type="number" 
                    min="0"
                    value={editScoreA} 
                    onChange={e => setEditScoreA(e.target.value)}
                    className="w-16 bg-slate-900 border border-white/10 rounded px-2 py-1 text-center font-bold outline-none focus:border-primary"
                  />
                </div>
                <div className="space-y-2 mb-4">
                  {editTeamA.map(p => (
                    <div key={p.player_id} className="flex justify-between items-center bg-slate-900/50 px-3 py-2 rounded text-sm">
                      <span className="text-slate-300">{p.player_name}</span>
                      <button onClick={() => handleRemovePlayer(p.player_id, 'A')} className="text-red-400 hover:text-red-300"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <select onChange={(e) => handleAddPlayer(e, 'A')} className="w-full bg-slate-900 border border-white/10 text-slate-300 rounded px-3 py-2 text-sm outline-none">
                  <option value="">+ Add Player to Team A</option>
                  {availablePlayers.map(p => <option key={p.player_id} value={p.player_id}>{p.player_name}</option>)}
                </select>
              </div>

              {/* Team B Edit */}
              <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                <div className="flex justify-between items-center mb-4">
                  <input 
                    type="text" 
                    value={editTeamBName}
                    onChange={(e) => setEditTeamBName(e.target.value)}
                    className="font-bold text-lg bg-transparent border-b border-transparent hover:border-white/20 focus:border-primary outline-none transition-colors w-2/3"
                    placeholder="Team B Name"
                  />
                  <input 
                    type="number" 
                    min="0"
                    value={editScoreB} 
                    onChange={e => setEditScoreB(e.target.value)}
                    className="w-16 bg-slate-900 border border-white/10 rounded px-2 py-1 text-center font-bold outline-none focus:border-primary"
                  />
                </div>
                <div className="space-y-2 mb-4">
                  {editTeamB.map(p => (
                    <div key={p.player_id} className="flex justify-between items-center bg-slate-900/50 px-3 py-2 rounded text-sm">
                      <span className="text-slate-300">{p.player_name}</span>
                      <button onClick={() => handleRemovePlayer(p.player_id, 'B')} className="text-red-400 hover:text-red-300"><X className="w-4 h-4" /></button>
                    </div>
                  ))}
                </div>
                <select onChange={(e) => handleAddPlayer(e, 'B')} className="w-full bg-slate-900 border border-white/10 text-slate-300 rounded px-3 py-2 text-sm outline-none">
                  <option value="">+ Add Player to Team B</option>
                  {availablePlayers.map(p => <option key={p.player_id} value={p.player_id}>{p.player_name}</option>)}
                </select>
              </div>

            </div>

            <button 
              onClick={handleSaveEdit}
              disabled={isSaving}
              className="w-full btn-primary py-3 font-bold flex justify-center items-center text-lg disabled:opacity-50"
            >
              {isSaving ? <RefreshCcw className="w-5 h-5 mr-2 animate-spin" /> : <Save className="w-5 h-5 mr-2" />}
              {isSaving ? 'Recalculating History...' : 'Save & Recalculate Elo'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
