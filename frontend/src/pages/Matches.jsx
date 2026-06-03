import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, MapPin, Zap } from 'lucide-react';
import api from '../utils/api';

export default function Matches() {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/matches')
      .then(res => {
        setMatches(res.data);
        setLoading(false);
      })
      .catch(err => console.error(err));
  }, []);

  if (loading) return <div className="text-center py-10 text-slate-400">Loading matches...</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
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
          
          // Upset Logic
          const isTeamAUpset = teamAWon && match.expected_win_team_a !== null && match.expected_win_team_a < 0.35;
          const isTeamBUpset = teamBWon && match.expected_win_team_b !== null && match.expected_win_team_b < 0.35;
          const isUpset = isTeamAUpset || isTeamBUpset;

          return (
            <div key={match.match_id} className="glass-panel p-0 relative overflow-hidden flex flex-col md:flex-row border-white/10 group">
              
              {/* Upset Banner on Mobile (Top) / Desktop (Left Edge) */}
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
                <div className="flex flex-col w-full md:w-3/4 bg-slate-900/40 rounded-2xl p-6 border border-white/5 relative">
                  
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex-1 text-center">
                      <div className={`text-2xl font-black ${teamAWon ? 'text-secondary' : 'text-slate-400'}`}>
                        {match.team_a_name || 'Team A'}
                      </div>
                      {match.team_a_avg_elo && (
                        <div className="text-xs font-bold text-slate-500 mt-1 uppercase tracking-wider">
                          {Math.round(match.team_a_avg_elo)} Avg Elo
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center space-x-6 px-4 shrink-0">
                      <div className={`text-4xl font-black ${teamAWon ? 'text-white drop-shadow-md' : 'text-slate-600'}`}>
                        {match.team_a_score}
                      </div>
                      <div className="text-slate-700 font-bold text-xl">-</div>
                      <div className={`text-4xl font-black ${teamBWon ? 'text-white drop-shadow-md' : 'text-slate-600'}`}>
                        {match.team_b_score}
                      </div>
                    </div>
                    
                    <div className="flex-1 text-center">
                      <div className={`text-2xl font-black ${teamBWon ? 'text-secondary' : 'text-slate-400'}`}>
                        {match.team_b_name || 'Team B'}
                      </div>
                      {match.team_b_avg_elo && (
                        <div className="text-xs font-bold text-slate-500 mt-1 uppercase tracking-wider">
                          {Math.round(match.team_b_avg_elo)} Avg Elo
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex justify-between text-sm border-t border-white/5 pt-4">
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
                    <div className="mt-6 pt-4 border-t border-white/5">
                      <div className="flex justify-between text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1.5">
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
        {matches.length === 0 && (
          <div className="glass-panel p-12 text-center">
            <p className="text-slate-400 mb-4">No matches recorded yet.</p>
            <Link to="/matches/new" className="btn-primary">Create the first match</Link>
          </div>
        )}
      </div>
    </div>
  );
}
