var fs = require('fs'),
  path = require('path'),
  out = '/tmp/luma-artwork',
  map = {},
  seen = {};
try {
  fs.mkdirSync(out);
} catch {}
[
  '/media/developer/apps/usr/palm/applications',
  '/media/cryptofs/apps/usr/palm/applications',
  '/usr/palm/applications',
].forEach(function (root) {
  try {
    fs.readdirSync(root).forEach(function (d) {
      try {
        var dir = path.join(root, d),
          a = JSON.parse(fs.readFileSync(path.join(dir, 'appinfo.json'), 'utf8'));
        if (!a.id || seen[a.id]) return;
        seen[a.id] = true;
        var choices = [a.largeIcon, a.icon, 'icon.png'],
          src;
        choices.some(function (i) {
          if (typeof i !== 'string' || !i) return false;
          var p = i[0] === '/' ? i : path.join(dir, i);
          try {
            if (fs.statSync(p).isFile()) {
              src = p;
              return true;
            }
          } catch {}
          return false;
        });
        if (!src) return;
        var ext = path.extname(src).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].indexOf(ext) < 0) return;
        var name = Object.keys(map).length + ext;
        fs.writeFileSync(path.join(out, name), fs.readFileSync(src));
        map[a.id] = './app-icons/' + name;
      } catch {}
    });
  } catch {}
});
fs.writeFileSync(path.join(out, 'app-icons.json'), JSON.stringify(map, null, 2));
console.log('Collected ' + Object.keys(map).length + ' app icons');
