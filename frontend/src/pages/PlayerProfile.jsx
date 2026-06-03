import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import api from '../utils/api';

export default function PlayerProfile() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

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

  const { player, history } = data;
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
              <div className="h-full flex items-center justify-center text-slate-500">Not enough data to display graph</div>
            )}
          </div>
        </div>

        {/* Match History List */}
        <div className="glass-panel p-6 overflow-hidden flex flex-col max-h-[400px]">
          <h2 className="text-xl font-semibold mb-4">Match History</h2>
          <div className="overflow-y-auto pr-2 space-y-3 flex-grow">
            {history.map(match => {
              const isWin = (match.team === match.winning_team);
              const change = Math.round(match.elo_change);
              
              return (
                <div key={match.id} className="bg-white/5 p-3 rounded-xl border border-white/5">
                  <div className="flex justify-between items-start mb-2">
                    <span className={`text-xs font-bold px-2 py-1 rounded ${isWin ? 'bg-secondary/20 text-secondary' : 'bg-red-500/20 text-red-400'}`}>
                      {isWin ? 'WIN' : 'LOSS'}
                    </span>
                    <span className="text-xs text-slate-400">{new Date(match.match_date).toLocaleDateString()}</span>
                  </div>
                  
                  <div className="flex justify-between items-center text-sm">
                    <div className="text-slate-300">
                      Team {match.team}
                    </div>
                    <div className={`flex items-center font-bold ${change > 0 ? 'text-secondary' : change < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                      {change > 0 ? <TrendingUp className="w-3 h-3 mr-1" /> : change < 0 ? <TrendingDown className="w-3 h-3 mr-1" /> : <Minus className="w-3 h-3 mr-1" />}
                      {change > 0 ? '+' : ''}{change}
                    </div>
                  </div>
                </div>
              );
            })}
            {history.length === 0 && <div className="text-slate-400 text-sm text-center py-4">No matches played yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
