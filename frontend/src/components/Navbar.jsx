import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Activity, Users, Wand2, Menu, X, Star, ClipboardCheck, CreditCard, ThumbsUp, CalendarDays } from 'lucide-react';
import { getSessionId, isAdminView, setAdminView, setAdminKey } from '../pages/v2/_api';

export default function Navbar() {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Re-evaluated on every route change (useLocation dep) so the nav reflects
  // login state right after a magic-link redeem and the admin flag after `?admin=1`.
  const [admin, setAdmin] = useState(isAdminView());
  const [loggedIn, setLoggedIn] = useState(!!getSessionId());

  useEffect(() => {
    // Admin unlock/lock via `?admin=1` / `?admin=0` — device-local, then strip
    // the param so it never gets shared or screenshotted.
    const qs = new URLSearchParams(location.search);
    let changed = false;
    if (qs.has('admin')) { setAdminView(qs.get('admin') === '1'); qs.delete('admin'); changed = true; }
    if (qs.has('key'))   { setAdminKey(qs.get('key')); qs.delete('key'); changed = true; }
    if (changed) {
      const next = location.pathname + (qs.toString() ? `?${qs}` : '') + location.hash;
      window.history.replaceState({}, document.title, next);
    }
    setAdmin(isAdminView());
    setLoggedIn(!!getSessionId());
  }, [location]);

  // Three visibility buckets:
  //   public  → everyone (spectators included)
  //   player  → only when a magic-link session exists
  //   admin   → only when the device-local admin flag is set
  const publicItems = [
    { path: '/v2/results',     label: 'Last Week',   icon: CalendarDays },
    { path: '/v2/leaderboard', label: 'Leaderboard', icon: Users },
  ];
  const playerItems = [
    { path: '/v2/me',      label: 'My Card', icon: CreditCard },
    { path: '/v2/me/rate', label: 'Rate',    icon: ThumbsUp },
  ];
  const adminItems = [
    { path: '/v2/admin-rating', label: 'Admin Rating', icon: Star },
    { path: '/v2/builder',      label: 'Team Builder',  icon: Wand2 },
    { path: '/v2/survey/0',     label: 'Survey',        icon: ClipboardCheck },
  ];

  const navItems = [
    ...publicItems,
    ...(loggedIn ? playerItems : []),
    ...(admin ? adminItems : []),
  ];

  return (
    <nav className="bg-surface/90 backdrop-blur-md border-b border-white/5 sticky top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/v2/leaderboard" className="flex items-center space-x-2 text-primary font-bold text-xl tracking-tight z-50">
            <Activity className="w-6 h-6" />
            <span>UltiElo <span className="text-xs text-slate-500 font-normal align-middle">v2</span></span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex space-x-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center space-x-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-slate-400 hover:text-white focus:outline-none z-50"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Nav Overlay */}
      {mobileMenuOpen && (
        <div className="md:hidden absolute top-16 left-0 w-full bg-surface/95 backdrop-blur-xl border-b border-white/10 shadow-2xl animate-in slide-in-from-top-2 duration-200">
          <div className="px-4 pt-2 pb-6 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-base font-medium transition-colors ${
                    isActive
                      ? 'bg-primary/15 text-primary border border-primary/20'
                      : 'text-slate-300 hover:text-white hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
}
