// Gera ui.js (HTML embutido) e o .exe para Windows
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/ui/index.html', 'utf8');
fs.writeFileSync(__dirname + '/ui.js', 'module.exports = ' + JSON.stringify(html) + ';\n');
console.log('ui.js gerado (' + html.length + ' bytes)');
const version = process.env.APP_VERSION || require('./package.json').version;
fs.writeFileSync(__dirname + '/version.js', 'module.exports = ' + JSON.stringify(String(version).replace(/^v/i, '')) + ';\n');
console.log('version.js: ' + version);
