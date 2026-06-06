const fs = require('fs');
const path = require('path');

const map = {
  'text-white': 'text-slate-900',
  'text-slate-200': 'text-slate-800',
  'text-slate-300': 'text-slate-700',
  'text-slate-400': 'text-slate-500',
  'bg-white/5': 'bg-slate-50',
  'bg-white/10': 'bg-slate-100',
  'border-white/5': 'border-slate-200',
  'border-white/10': 'border-slate-200',
  'border-white/20': 'border-slate-300',
  'bg-surface/90': 'bg-white/90',
  '#1e293b': '#ffffff', 
  '#334155': '#e2e8f0', 
  '#94a3b8': '#475569', 
};

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(walk(file));
    } else { 
      if (file.endsWith('.jsx')) results.push(file);
    }
  });
  return results;
}

const files = walk(path.join(__dirname, 'src'));
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  Object.keys(map).forEach(key => {
    const value = map[key];
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(escapedKey + '(?![\\w\\/])', 'g');
    content = content.replace(regex, value);
  });
  fs.writeFileSync(file, content);
});
console.log('Replaced themes across ' + files.length + ' files');
