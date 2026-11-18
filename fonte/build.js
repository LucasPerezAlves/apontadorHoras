// Gera ui.js (HTML embutido) e o .exe para Windows
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/ui/index.html', 'utf8');
fs.writeFileSync(__dirname + '/ui.js', 'module.exports = ' + JSON.stringify(html) + ';\n');
console.log('ui.js gerado (' + html.length + ' bytes)');
