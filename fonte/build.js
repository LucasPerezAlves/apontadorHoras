// Gera ui.js (HTML embutido) e o .exe para Windows
const fs = require('fs');
// Ícone da janela/barra de tarefas: PNGs de icone/ embutidos como data URL
const png = (n) => 'data:image/png;base64,' + fs.readFileSync(__dirname + '/icone/icone-' + n + '.png').toString('base64');
const html = fs.readFileSync(__dirname + '/ui/index.html', 'utf8').replaceAll('__ICON_32__', png(32)).replace('__ICON_192__', png(192));
fs.writeFileSync(__dirname + '/ui.js', 'module.exports = ' + JSON.stringify(html) + ';\n');
console.log('ui.js gerado (' + html.length + ' bytes)');
const version = process.env.APP_VERSION || require('./package.json').version;
fs.writeFileSync(__dirname + '/version.js', 'module.exports = ' + JSON.stringify(String(version).replace(/^v/i, '')) + ';\n');
console.log('version.js: ' + version);
