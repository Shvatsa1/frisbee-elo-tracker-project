import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';

export default function Players() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fetchPlayers = () => {
    api.get('/players')
      .then(res => {
        setPlayers(res.data);
        setLoading(false);
      })
      .catch(err => console.error(err));
  };

  useEffect(() => {
    fetchPlayers();
  }, []);

  const handleAddPlayer = async (e) => {
    e.preventDefault();
    if (!newPlayerName.trim()) return;
    setIsSubmitting(true);
    setError('');
    
    try {
      await api.post('/players', { player_name: newPlayerName.trim() });
      setNewPlayerName('');
      fetchPlayers(); // Refresh the list
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add player');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) return <div className="text-center py-10 text-slate-400">Loading leaderboard...</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
        <form onSubmit={handleAddPlayer} className="flex gap-2 w-full md:w-auto">
          <input 
            type="text" 
            placeholder="New Player Name" 
            className="input-field max-w-[200px]"
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
            disabled={isSubmitting}
          />
          <button 
            type="submit" 
            className="btn-primary whitespace-nowrap"
            disabled={isSubmitting || !newPlayerName.trim()}
          >
            {isSubmitting ? 'Adding...' : 'Add Player'}
          </button>
        </form>
      </div>
      {error && <div className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg">{error}</div>}

      <div className="glass-panel overflow-hidden">
        {/* Desktop Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white/5 border-b border-white/10 text-sm text-slate-400">
                <th className="p-4 font-medium">Rank</th>
                <th className="p-4 font-medium">Player</th>
                <th className="p-4 font-medium">Elo Rating</th>
                <th className="p-4 font-medium">Trend</th>
                <th className="p-4 font-medium">Streak</th>
                <th className="p-4 font-medium">Games</th>
                <th className="p-4 font-medium">Win %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {players.map((player, index) => {
                const winRate = player.win_percentage || 0;
                const trend = player.last_elo_change || 0;
                
                return (
                  <tr key={player.player_id} className="hover:bg-white/5 transition-colors">
                    <td className="p-4">
                      <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
                        index === 0 ? 'bg-amber-500/20 text-amber-500' :
                        index === 1 ? 'bg-slate-300/20 text-slate-300' :
                        index === 2 ? 'bg-amber-700/20 text-amber-600' :
                        'text-slate-500'
                      }`}>
                        {index + 1}
                      </span>
                    </td>
                    <td className="p-4">
                      <Link to={`/players/${player.player_id}`} className="font-medium hover:text-primary transition-colors text-lg">
                        {player.player_name}
                      </Link>
                    </td>
                    <td className="p-4 font-black text-accent text-lg">
                      {Math.round(player.current_elo)}
                    </td>
                    <td className="p-4">
                      {trend !== 0 && (
                        <span className={`flex items-center text-sm font-bold ${trend > 0 ? 'text-secondary' : 'text-red-500'}`}>
                          {trend > 0 ? '↑' : '↓'} {Math.abs(Math.round(trend))}
                        </span>
                      )}
                    </td>
                    <td className="p-4">
                      {player.streak >= 3 ? (
                        <span className="flex items-center text-amber-500 font-bold bg-amber-500/10 px-2 py-1 rounded w-max">
                          🔥 {player.streak} W
                        </span>
                      ) : player.streak > 0 ? (
                        <span className="text-secondary font-medium">{player.streak} W</span>
                      ) : player.streak < 0 ? (
                        <span className="text-red-500 font-medium">{Math.abs(player.streak)} L</span>
                      ) : (
                        <span className="text-slate-500">-</span>
                      )}
                    </td>
                    <td className="p-4 text-slate-300">
                      {player.total_games} <span className="text-xs text-slate-500">({player.wins}W - {player.losses}L)</span>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center space-x-2">
                        <div className="w-16 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-secondary" style={{ width: `${Math.round(winRate)}%` }} />
                        </div>
                        <span className="text-sm text-slate-400">{Math.round(winRate)}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile Cards */}
        <div className="md:hidden divide-y divide-white/5">
          {players.map((player, index) => {
            const winRate = player.win_percentage || 0;
            const trend = player.last_elo_change || 0;
            return (
              <div key={player.player_id} className="p-4 flex items-center justify-between hover:bg-white/5 transition-colors">
                <div className="flex items-center gap-3">
                  <span className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center font-bold text-sm ${
                    index === 0 ? 'bg-amber-500/20 text-amber-500' :
                    index === 1 ? 'bg-slate-300/20 text-slate-300' :
                    index === 2 ? 'bg-amber-700/20 text-amber-600' :
                    'text-slate-500'
                  }`}>
                    {index + 1}
                  </span>
                  <div>
                    <Link to={`/players/${player.player_id}`} className="font-bold text-lg hover:text-primary transition-colors block">
                      {player.player_name}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-slate-400 mt-1">
                      <span>{player.total_games} matches</span>
                      <span>•</span>
                      <span>{Math.round(winRate)}% Win</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-black text-accent text-xl">{Math.round(player.current_elo)}</div>
                  <div className="flex items-center justify-end gap-2 mt-1">
                    {trend !== 0 && (
                      <span className={`text-xs font-bold ${trend > 0 ? 'text-secondary' : 'text-red-500'}`}>
                        {trend > 0 ? '↑' : '↓'}{Math.abs(Math.round(trend))}
                      </span>
                    )}
                    {player.streak >= 3 && <span className="text-amber-500 text-xs font-bold">🔥{player.streak}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        
        {players.length === 0 && <div className="p-8 text-center text-slate-400">No players found.</div>}
      </div>
    </div>
  );
}
