import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    const success = await login(password);
    if (success) {
      navigate('/');
    } else {
      setError('Invalid password');
    }
    setIsLoading(false);
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-8 glass-panel animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col items-center mb-8">
        <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mb-4 border border-primary/30 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
          <Lock className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-3xl font-black text-white">Admin Login</h1>
        <p className="text-slate-400 text-sm mt-2">Enter secret password to manage data</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Password</label>
          <input
            type="password"
            className="input-field w-full text-center tracking-[0.5em] text-xl"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </div>

        {error && <div className="text-red-400 text-sm font-bold text-center bg-red-400/10 py-2 rounded-lg">{error}</div>}

        <button 
          type="submit" 
          className="btn-primary w-full py-3 text-lg relative overflow-hidden group"
          disabled={isLoading}
        >
          <span className="relative z-10">{isLoading ? 'Verifying...' : 'Unlock'}</span>
          <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300"></div>
        </button>
      </form>
    </div>
  );
}
