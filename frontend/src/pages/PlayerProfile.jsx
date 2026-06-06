import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { TrendingUp, TrendingDown, Minus, X, Users, Crosshair } from 'lucide-react';
import api from '../utils/api';

export default function PlayerProfile() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedMatch, setSelectedMatch] = useState(null);

  useEffect(() => {
    api.get(`/players/${id}`)
      .then(res => {
        setData(res.data);
        setLoading(false);
      })
      .catch(err => console.error(err));
  }, [id]);

  if (loading) return <div className="text-center py-10 text-slate-400">Loading profile...</div>;
  if (!data) return <div className="text-center py-10 text-red-400">Player not found</div>;

  const { player, history, bestAlly, nemesis } = data;
  const winRate = player.total_games > 0 ? Math.round((player.wins / player.total_games) * 100) : 0;

  // Prepare chart data (reverse history to show chronological order left-to-right)
  const chartData = [...history].reverse().map((match, i) => ({
    name: `Match ${i + 1}`,
    elo: Math.round(match.elo_after),
    date: new Date(match.match_date).toLocaleDateString()
  }));

  // Add initial Elo (1000) at the start
  if (chartData.length > 0) {
    chartData.unshift({
      name: 'Start',
      elo: 1000,
      date: 'Initial'
    });
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header Profile Card */}
      <div className="glass-panel p-8 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <h1 className="text-4xl font-bold mb-2">{player.player_name}</h1>
            <div className="flex space-x-6 text-sm text-slate-400">
              <div className="flex flex-col">
                <span className="uppercase text-xs tracking-wider">Current Elo</span>
                <span className="text-2xl font-bold text-accent">{Math.round(player.current_elo)}</span>
              </div>
              <div className="flex flex-col">
                <span className="uppercase text-xs tracking-wider">Win Rate</span>
                <span className="text-2xl font-bold text-slate-200">{winRate}%</span>
              </div>
              <div className="flex flex-col">
                <span className="uppercase text-xs tracking-wider">Record</span>
                <span className="text-2xl font-bold text-slate-200">{player.wins}W - {player.losses}L</span>
              </div>
            </div>
            <div className="flex space-x-6 text-sm text-slate-400 mt-4 border-t border-white/10 pt-4">
              <div className="flex flex-col">
                <span className="uppercase text-xs tracking-wider flex items-center"><Users className="w-3 h-3 mr-1"/> Best Ally</span>
                <span className="text-lg font-bold text-slate-200">{bestAlly ? bestAlly.player_name : '-'}</span>
              </div>
              <div className="flex flex-col">
                <span className="uppercase text-xs tracking-wider flex items-center"><Crosshair className="w-3 h-3 mr-1"/> Nemesis</span>
                <span className="text-lg font-bold text-slate-200">{nemesis ? nemesis.player_name : '-'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Graph */}
        <div className="glass-panel p-6 lg:col-span-2">
          <h2 className="text-xl font-semibold mb-6">Rating Progression</h2>
          <div className="h-[300px] w-full">
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                  <XAxis dataKey="name" stroke="#64748b" tick={{fill: '#64748b'}} />
                  <YAxis domain={['auto', 'auto']} stroke="#64748b" tick={{fill: '#64748b'}} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', borderRadius: '8px' }}
                    labelStyle={{ color: '#94a3b8' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="elo" 
                    stroke="#3b82f6" 
                    strokeWidth={3}
                    dot={{ fill: '#3b82f6', strokeWidth: 2 }}
                    activeDot={{ r: 8, fill: '#f59e0b', stroke: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400">Not enough data to display graph</div>
            )}
          </div>
        </div>

        {/* Match History List */}
        <div className="glass-panel p-6 overflow-hidden flex flex-col max-h-[400px]">
          <h2 className="text-xl font-semibold mb-4">Match History</h2>
          <div className="overflow-y-auto pr-2 space-y-3 flex-grow">
            {history.map(match => {
              const isWin = (match.player_team === match.winning_team);
              const change = Math.round(match.elo_change);
              const myTeamName = match.player_team === 'A' ? (match.team_a_name || 'Team A') : (match.team_b_name || 'Team B');
              
              return (
                <button 
                  key={match.match_id} 
                  onClick={() => setSelectedMatch(match)}
                  className="bg-white/5 p-3 rounded-xl border border-white/10 w-full text-left hover:bg-white/10 transition-colors"
                >
                  <div className="flex justify-between items-start mb-2">
                    <span className={`text-xs font-bold px-2 py-1 rounded ${isWin ? 'bg-secondary/20 text-secondary' : 'bg-red-500/20 text-red-400'}`}>
                      {isWin ? 'WIN' : 'LOSS'}
                    </span>
                    <span className="text-xs text-slate-400">{new Date(match.match_date).toLocaleDateString()}</span>
                  </div>
                  
                  <div className="flex justify-between items-center text-sm">
                    <div className="text-slate-300 font-medium">
                      {myTeamName}
                    </div>
                    <div className={`flex items-center font-bold ${change > 0 ? 'text-secondary' : change < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                      {change > 0 ? <TrendingUp className="w-3 h-3 mr-1" /> : change < 0 ? <TrendingDown className="w-3 h-3 mr-1" /> : <Minus className="w-3 h-3 mr-1" />}
                      {change > 0 ? '+' : ''}{change}
                    </div>
                  </div>
                </button>
              );
            })}
            {history.length === 0 && <div className="text-slate-400 text-sm text-center py-4">No matches played yet.</div>}
          </div>
        </div>
      </div>
      
      {/* Match Details Modal */}
      {selectedMatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setSelectedMatch(null)}>
          <div className="glass-panel w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-white/10 flex justify-between items-center sticky top-0 bg-surface/90 backdrop-blur-md z-10">
              <h2 className="text-xl font-bold">Match Details</h2>
              <button onClick={() => setSelectedMatch(null)} className="p-2 hover:bg-white/10 rounded-full transition-colors text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6">
              <div className="text-center mb-8">
                <div className="text-sm text-slate-400 mb-2">{new Date(selectedMatch.match_date).toLocaleDateString()} {selectedMatch.location ? `• ${selectedMatch.location}` : ''}</div>
                <div className="flex justify-center items-center gap-6 text-3xl font-black">
                  <span className={selectedMatch.winning_team === 'A' ? 'text-white' : 'text-slate-400'}>{selectedMatch.team_a_score}</span>
                  <span className="text-slate-600 text-xl">-</span>
                  <span className={selectedMatch.winning_team === 'B' ? 'text-white' : 'text-slate-400'}>{selectedMatch.team_b_score}</span>
                </div>
              </div>
              
              <div className="grid md:grid-cols-2 gap-8">
                {/* Team A */}
                <div>
                  <h3 className={`text-lg font-bold mb-4 border-b border-white/10 pb-2 ${selectedMatch.winning_team === 'A' ? 'text-secondary' : 'text-slate-300'}`}>
                    {selectedMatch.team_a_name || 'Team A'} {selectedMatch.winning_team === 'A' && '🏆'}
                  </h3>
                  <div className="space-y-2">
                    {selectedMatch.players?.filter(p => p.team === 'A').map(p => (
                      <div key={p.player_id} className={`flex justify-between items-center p-2 rounded-lg ${p.player_id === player.player_id ? 'bg-primary/20 text-white font-bold' : 'bg-white/5 text-slate-300'}`}>
                        <span>{p.player_name}</span>
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Team B */}
                <div>
                  <h3 className={`text-lg font-bold mb-4 border-b border-white/10 pb-2 ${selectedMatch.winning_team === 'B' ? 'text-secondary' : 'text-slate-300'}`}>
                    {selectedMatch.team_b_name || 'Team B'} {selectedMatch.winning_team === 'B' && '🏆'}
                  </h3>
                  <div className="space-y-2">
                    {selectedMatch.players?.filter(p => p.team === 'B').map(p => (
                      <div key={p.player_id} className={`flex justify-between items-center p-2 rounded-lg ${p.player_id === player.player_id ? 'bg-primary/20 text-white font-bold' : 'bg-white/5 text-slate-300'}`}>
                        <span>{p.player_name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
