import { useState, useEffect } from 'react';
import { Users, Activity, Trophy, Flame, Target, Zap, Clock, Shield, MapPin, Plus, TrendingUp, TrendingDown, Crosshair } from 'lucide-react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [trending, setTrending] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    Promise.all([
      api.get('/dashboard'),
      api.get('/dashboard/trending'),
      api.get('/activity')
    ]).then(([statsRes, trendingRes, activityRes]) => {
      setStats(statsRes.data);
      setTrending(trendingRes.data);
      setActivity(activityRes.data);
      setLoading(false);
    }).catch(err => {
      console.error(err);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-center py-20 text-slate-400">Loading premium dashboard...</div>;
  if (!stats) return <div className="text-center py-20 text-red-400">Failed to load data</div>;

  const mostActive = [...stats.topPlayers].sort((a, b) => b.total_games - a.total_games)[0];
  const highestWin = [...stats.topPlayers].sort((a, b) => b.win_percentage - a.win_percentage)[0];

  return (
    <div className="animate-in fade-in duration-500 pb-10 max-w-[1600px] mx-auto">
      
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
        
        {/* LEFT COLUMN: Top Players */}
        <div className="xl:col-span-1 space-y-4">
          <div className="flex justify-between items-end mb-2">
            <h2 className="text-sm font-black tracking-widest uppercase text-slate-300 flex items-center">
              <Trophy className="w-4 h-4 mr-2 text-accent" /> TOP PLAYERS
            </h2>
            <Link to="/players" className="text-xs text-primary hover:text-blue-400 transition-colors">View Full Rankings →</Link>
          </div>
          
          <div className="glass-panel p-4 flex flex-col space-y-1">
            <div className="flex text-[10px] font-bold text-slate-400 uppercase tracking-widest pb-2 border-b border-white/10 px-2">
              <div className="w-8">RANK</div>
              <div className="flex-1">PLAYER</div>
              <div className="w-16 text-right">RATING</div>
              <div className="w-16 text-right">TREND</div>
              <div className="w-12 text-right">STREAK</div>
            </div>
            
            {stats.topPlayers.map((player, idx) => {
              const trend = player.last_elo_change || 0;
              return (
                <div key={player.player_id} className="flex items-center text-sm py-2.5 px-2 hover:bg-white/5 rounded-lg transition-colors group cursor-default">
                  <div className={`w-8 font-black ${idx < 3 ? 'text-white' : 'text-slate-400'}`}>{idx + 1}</div>
                  <div className="flex-1 flex items-center space-x-3">
                    <div className="w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-[10px] font-bold border border-white/10 shrink-0">
                      {player.player_name.substring(0, 2).toUpperCase()}
                    </div>
                    <Link to={`/players/${player.player_id}`} className="font-semibold text-slate-200 group-hover:text-primary transition-colors truncate">
                      {player.player_name}
                    </Link>
                  </div>
                  <div className="w-16 text-right font-bold text-white">{Math.round(player.current_elo)}</div>
                  <div className={`w-16 text-right font-medium text-xs flex items-center justify-end ${trend >= 0 ? 'text-secondary' : 'text-red-500'}`}>
                    {trend >= 0 ? <TrendingUp className="w-3 h-3 mr-1" /> : <TrendingDown className="w-3 h-3 mr-1" />}
                    {Math.abs(Math.round(trend))}
                  </div>
                  <div className="w-12 text-right font-bold text-accent flex items-center justify-end">
                    {player.streak > 0 && <><Flame className="w-3 h-3 mr-1" />{player.streak}</>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* CENTER COLUMN: Hero & Matches & Pulse */}
        <div className="xl:col-span-2 flex flex-col space-y-6">
          
          {/* Hero Section */}
          <div className="glass-panel relative overflow-hidden p-8 flex flex-col justify-between min-h-[320px]">
            {/* Background Image / Blur */}
            <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1598024220557-93ba2a488e02?auto=format&fit=crop&q=80')] bg-cover bg-center opacity-10 mix-blend-overlay"></div>
            <div className="absolute inset-0 bg-gradient-to-t from-[#131C31] via-[#131C31]/80 to-transparent"></div>
            
            <div className="relative z-10 mb-8">
              <h1 className="text-5xl md:text-6xl font-black tracking-tight mb-2 leading-none uppercase">
                Mumbai's Ultimate<br/>
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-indigo-600 italic">RANKINGS</span>
              </h1>
              <p className="text-slate-400 font-medium tracking-wide">Track. Compete. Improve. Repeat.</p>
              
              <div className="flex gap-3 mt-6">
                <Link to="/players" className="btn-primary flex items-center shadow-blue-500/20"><Trophy className="w-4 h-4 mr-2" /> View Rankings</Link>
                {isAuthenticated && (
                  <Link to="/gameday" className="btn-secondary flex items-center"><Zap className="w-4 h-4 mr-2" /> Record Match</Link>
                )}
              </div>
            </div>
            
            {/* 4 Stat Cards overlaying hero */}
            <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-4 mt-auto">
              <div className="bg-surface/90 backdrop-blur-md border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center text-center shadow-sm">
                <Users className="w-5 h-5 text-indigo-500 mb-2" />
                <div className="text-3xl font-black text-white">{stats.totalPlayers}</div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Players</div>
              </div>
              <div className="bg-surface/90 backdrop-blur-md border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center text-center shadow-sm">
                <Activity className="w-5 h-5 text-secondary mb-2" />
                <div className="text-3xl font-black text-white">{stats.totalMatches}</div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Matches</div>
              </div>
              <div className="bg-surface/90 backdrop-blur-md border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center text-center shadow-sm">
                <Target className="w-5 h-5 text-amber-500 mb-2" />
                <div className="text-3xl font-black text-white">
                  {Math.round(stats.pulse.avgTeamElo * 2 / 14)} 
                </div>
                <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Avg Score</div>
              </div>
              <div className="bg-surface/90 backdrop-blur-md border border-white/10 rounded-xl p-4 flex flex-col items-center justify-center text-center shadow-[0_0_15px_rgba(14,165,233,0.15)] border-primary/30">
                <Flame className="w-5 h-5 text-primary mb-2" />
                <div className="text-3xl font-black text-white">{stats.insights?.streak || 0}</div>
                <div className="text-[10px] font-bold text-primary uppercase tracking-widest mt-1">Live Win Streak</div>
              </div>
            </div>
          </div>
          
          {/* Recent Matches */}
          <div className="space-y-4">
            <div className="flex justify-between items-end mb-2">
              <h2 className="text-sm font-black tracking-widest uppercase text-slate-300 flex items-center">
                <Clock className="w-4 h-4 mr-2 text-primary" /> RECENT MATCHES
              </h2>
              <Link to="/matches" className="text-xs text-primary hover:text-blue-400 transition-colors">View All Matches →</Link>
            </div>
            
            <div className="glass-panel divide-y divide-white/5">
              {stats.latestMatches.slice(0, 4).map(match => {
                const teamAWon = match.winning_team === 'A';
                const teamBWon = match.winning_team === 'B';
                const isTeamAUpset = teamAWon && match.expected_win_team_a < 0.35;
                const isTeamBUpset = teamBWon && match.expected_win_team_b < 0.35;
                const isUpset = isTeamAUpset || isTeamBUpset;
                
                return (
                  <div key={match.match_id} className="p-5 flex items-center justify-between hover:bg-white/[0.02] transition-colors relative overflow-hidden">
                    {/* Left side: Date/Venue */}
                    <div className="w-32 hidden md:block">
                      <div className="text-xs text-slate-400 mb-1">{new Date(match.match_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute:'2-digit' })}</div>
                      <div className="text-[10px] font-medium text-slate-400 uppercase truncate">{match.location || 'Unknown'}</div>
                    </div>
                    
                    {/* Center: Scoreboard */}
                    <div className="flex-1 flex items-center justify-center max-w-lg mx-auto">
                      {/* Team A */}
                      <div className="flex-1 flex items-center justify-end space-x-3 text-right">
                        <div>
                          <div className={`font-bold text-sm ${teamAWon ? 'text-white' : 'text-slate-400'}`}>{match.team_a_name || 'Team A'}</div>
                          <div className="text-[10px] text-slate-400">{Math.round(match.team_a_avg_elo)}</div>
                        </div>
                        <div className="w-8 h-8 rounded-full bg-white/10 border border-white/10 flex flex-col items-center justify-center">
                           <Shield className="w-4 h-4 text-slate-400" />
                        </div>
                      </div>
                      
                      {/* Scores */}
                      <div className="px-6 flex flex-col items-center">
                        <div className="flex items-center space-x-3 bg-white/5 rounded-lg px-4 py-1.5 border border-white/10">
                          <span className={`text-xl font-black ${teamAWon ? 'text-primary' : 'text-slate-400'}`}>{match.team_a_score}</span>
                          <span className="text-slate-400 text-sm">-</span>
                          <span className={`text-xl font-black ${teamBWon ? 'text-primary' : 'text-slate-400'}`}>{match.team_b_score}</span>
                        </div>
                        {teamAWon && <span className="text-[9px] font-bold uppercase tracking-widest text-secondary mt-1 bg-secondary/10 px-2 py-0.5 rounded">Team A Won</span>}
                        {teamBWon && <span className="text-[9px] font-bold uppercase tracking-widest text-secondary mt-1 bg-secondary/10 px-2 py-0.5 rounded">Team B Won</span>}
                      </div>
                      
                      {/* Team B */}
                      <div className="flex-1 flex items-center justify-start space-x-3">
                         <div className="w-8 h-8 rounded-full bg-white/10 border border-white/10 flex flex-col items-center justify-center">
                           <Shield className="w-4 h-4 text-slate-400" />
                        </div>
                        <div>
                          <div className={`font-bold text-sm ${teamBWon ? 'text-white' : 'text-slate-400'}`}>{match.team_b_name || 'Team B'}</div>
                          <div className="text-[10px] text-slate-400">{Math.round(match.team_b_avg_elo)}</div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Right side: Upset & Elo Swing */}
                    <div className="w-24 text-right flex flex-col items-end">
                      {isUpset && <span className="bg-amber-500/20 text-amber-500 text-[9px] font-black tracking-widest uppercase px-2 py-0.5 rounded mb-1 border border-amber-500/20">Upset</span>}
                      <div className="text-xs font-bold text-secondary flex items-center"><TrendingUp className="w-3 h-3 mr-1"/> Swing</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          
          {/* The Pulse of Mumbai Ultimate */}
          <div className="glass-panel p-6 border-white/10 mt-2 relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full blur-[40px] -translate-y-1/2 translate-x-1/2"></div>
            <h2 className="text-xs font-black tracking-widest uppercase text-slate-400 flex items-center justify-center mb-6 relative z-10">
               <Crosshair className="w-4 h-4 mr-2 text-indigo-400" /> THE PULSE OF MUMBAI ULTIMATE
            </h2>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 divide-x divide-white/5 relative z-10">
               <div className="px-4 text-center">
                 <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">Most Active Day</div>
                 <div className="text-lg font-black text-white">{stats.pulse.mostActiveDay?.day_name?.trim() || 'Unknown'}</div>
                 <div className="text-xs text-slate-400 mt-1">{stats.pulse.mostActiveDay?.matches || 0} matches</div>
               </div>
               <div className="px-4 text-center">
                 <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">Most Played Venue</div>
                 <div className="text-lg font-black text-white truncate px-2">{stats.pulse.mostPlayedVenue?.location || 'Unknown'}</div>
                 <div className="text-xs text-slate-400 mt-1">{stats.pulse.mostPlayedVenue?.matches || 0} matches</div>
               </div>
               <div className="px-4 text-center">
                 <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">Avg Team Elo</div>
                 <div className="text-lg font-black text-white">{Math.round(stats.pulse.avgTeamElo)}</div>
                 <div className="text-xs text-slate-400 mt-1">Across all teams</div>
               </div>
               <div className="px-4 text-center">
                 <div className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">New Players</div>
                 <div className="text-lg font-black text-indigo-400 flex justify-center items-center"><Users className="w-4 h-4 mr-1"/> Join In!</div>
                 <div className="text-xs text-slate-400 mt-1">Welcome!</div>
               </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Feed & Community */}
        <div className="xl:col-span-1 space-y-6">
          
          {/* Activity Feed */}
          <div className="glass-panel flex flex-col h-[350px]">
             <div className="p-4 border-b border-white/10 flex justify-between items-center bg-white/5 rounded-t-2xl">
               <h2 className="text-xs font-black tracking-widest uppercase text-slate-300 flex items-center">
                 <Flame className="w-4 h-4 mr-2 text-accent" /> ACTIVITY FEED
               </h2>
             </div>
             <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar">
                {activity.length === 0 && <div className="text-sm text-slate-400 text-center py-4">No recent activity.</div>}
                {activity.map((event, idx) => {
                  let Icon = Activity;
                  let colorClass = "text-slate-400";
                  
                  if (event.event_type === 'UPSET') { Icon = Zap; colorClass = "text-amber-500"; }
                  if (event.event_type === 'STREAK') { Icon = Flame; colorClass = "text-primary"; }
                  if (event.event_type === 'RANK_UP' || event.event_type === 'ELO_GAIN') { Icon = TrendingUp; colorClass = "text-secondary"; }
                  if (event.event_type === 'NEW_PLAYER') { Icon = Plus; colorClass = "text-indigo-400"; }

                  return (
                    <div key={event.id || idx} className="flex space-x-3 text-sm relative">
                       {idx !== activity.length - 1 && <div className="absolute top-6 left-3 w-px h-full bg-white/5 -translate-x-1/2"></div>}
                       <div className={`w-6 h-6 rounded-full bg-surface border border-white/10 flex items-center justify-center shrink-0 z-10 ${colorClass}`}>
                         <Icon className="w-3 h-3" />
                       </div>
                       <div className="flex-1 pb-2">
                         <div className="text-slate-300">{event.description}</div>
                         <div className="text-xs text-slate-400 mt-0.5">{new Date(event.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                       </div>
                    </div>
                  );
                })}
             </div>
          </div>
          
          {/* Fastest Rising */}
          <div className="glass-panel p-4">
             <div className="flex justify-between items-center mb-4">
               <h2 className="text-xs font-black tracking-widest uppercase text-slate-300 flex items-center">
                 <Zap className="w-4 h-4 mr-2 text-amber-500" /> FASTEST RISING
               </h2>
             </div>
             
             <div className="space-y-3">
               {trending.map((player, idx) => (
                 <div key={player.player_id} className="flex items-center justify-between group">
                    <div className="flex items-center space-x-2 text-sm">
                      <span className="w-4 text-xs font-bold text-slate-600">{idx + 1}</span>
                      <Link to={`/players/${player.player_id}`} className="font-semibold text-slate-300 group-hover:text-primary transition-colors truncate w-24">
                        {player.player_name}
                      </Link>
                    </div>
                    
                    <div className="w-24 h-6 opacity-60 group-hover:opacity-100 transition-opacity">
                      {player.history && player.history.length > 1 ? (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={player.history}>
                            <YAxis domain={['dataMin', 'dataMax']} hide />
                            <Line type="monotone" dataKey="elo_after" stroke="#10b981" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="w-full h-full bg-white/10 rounded flex items-center justify-center text-[8px] text-slate-400">No Data</div>
                      )}
                    </div>
                    
                    <div className="text-xs font-bold text-secondary w-10 text-right">
                       +{Math.round(player.history[player.history.length-1]?.elo_after - player.history[0]?.elo_after) || 0}
                    </div>
                 </div>
               ))}
             </div>
          </div>
          
          {/* Community Highlights Grid */}
          <div className="grid grid-cols-2 gap-3">
             <div className="glass-panel p-3 border-t-2 border-t-amber-500 flex flex-col items-center justify-center text-center">
               <div className="text-[9px] uppercase tracking-widest font-bold text-slate-400 mb-1 flex items-center"><Flame className="w-3 h-3 mr-1 text-amber-500"/> Longest Streak</div>
               <div className="text-xl font-black text-white">{stats.insights?.streak || 0}</div>
               <div className="text-[10px] text-slate-400 truncate w-full mt-1">{stats.insights?.player_name || 'N/A'}</div>
             </div>
             
             <div className="glass-panel p-3 border-t-2 border-t-primary flex flex-col items-center justify-center text-center">
               <div className="text-[9px] uppercase tracking-widest font-bold text-slate-400 mb-1 flex items-center"><Activity className="w-3 h-3 mr-1 text-primary"/> Most Active</div>
               <div className="text-xl font-black text-white">{mostActive?.total_games || 0}</div>
               <div className="text-[10px] text-slate-400 truncate w-full mt-1">{mostActive?.player_name || 'N/A'}</div>
             </div>
             
             <div className="glass-panel p-3 border-t-2 border-t-purple-500 flex flex-col items-center justify-center text-center">
               <div className="text-[9px] uppercase tracking-widest font-bold text-slate-400 mb-1 flex items-center"><Shield className="w-3 h-3 mr-1 text-purple-500"/> Games Played</div>
               <div className="text-xl font-black text-white">{stats.totalMatches}</div>
               <div className="text-[10px] text-slate-400 truncate w-full mt-1">Total System Matches</div>
             </div>
             
             <div className="glass-panel p-3 border-t-2 border-t-secondary flex flex-col items-center justify-center text-center">
               <div className="text-[9px] uppercase tracking-widest font-bold text-slate-400 mb-1 flex items-center"><TrendingUp className="w-3 h-3 mr-1 text-secondary"/> Highest Win %</div>
               <div className="text-xl font-black text-white">{Math.round(highestWin?.win_percentage || 0)}%</div>
               <div className="text-[10px] text-slate-400 truncate w-full mt-1">{highestWin?.player_name || 'N/A'}</div>
             </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
