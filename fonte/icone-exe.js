// Gera um Node base para Windows com o ícone e os dados do Apontador (descrição, versão).
// O pkg usa esse binário quando PKG_NODE_PATH aponta para ele. Mexer no .exe depois de
// empacotado corromperia o conteúdo embutido, por isso o ícone entra antes.
//
//   npm i --no-save resedit@2 @yao-pkg/pkg-fetch@3.6.7
//   node icone-exe.js            -> dist/node-base-win-x64.exe
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const { need } = require('@yao-pkg/pkg-fetch');

(async () => {
  const version = String(process.env.APP_VERSION || require('./package.json').version).replace(/^v/i, '');
  const base = await need({ nodeRange: 'node22', platform: 'win', arch: 'x64' });
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(base), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  // Ícone: troca o grupo de ícones que o Node já tem (o Explorer usa o primeiro)
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icone', 'icone.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const target = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, target.id, target.lang, ico.icons.map((i) => i.data));

  // Dados que aparecem nas Propriedades do arquivo e no Gerenciador de Tarefas
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [a, b, c] = version.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  vi.setFileVersion(a, b || 0, c || 0, 0, 1033);
  vi.setProductVersion(a, b || 0, c || 0, 0, 1033);
  const langs = vi.getAllLanguagesForStringValues();
  for (const l of langs.length ? langs : [{ lang: 1033, codepage: 1200 }]) {
    vi.setStringValues(l, {
      FileDescription: 'Apontador de Horas',
      ProductName: 'Apontador de Horas',
      CompanyName: 'Lucas Perez Alves',
      InternalName: 'ApontadorHoras',
      OriginalFilename: 'ApontadorHoras.exe',
      LegalCopyright: 'github.com/LucasPerezAlves/apontadorHoras',
      FileVersion: version,
      ProductVersion: version,
    });
  }
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  const out = path.join(__dirname, 'dist', 'node-base-win-x64.exe');
  fs.writeFileSync(out, Buffer.from(exe.generate()));
  console.log(`Node base com ícone: ${out} (versão ${version}, a partir de ${base})`);
})().catch((e) => { console.error(e); process.exit(1); });
