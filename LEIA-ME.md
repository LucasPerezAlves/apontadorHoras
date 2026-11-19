# Apontador de Horas

Mini aplicação para apontar horas no Work Session Hub do Azure DevOps (`emr-cm/EMR`).

## Usar
1. Dê dois cliques em `C:\ApontadorHoras\ApontadorHoras.exe`.
   - Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo** (o .exe não é assinado).
2. Na primeira vez, o app pede um **token pessoal (PAT)**:
   - https://dev.azure.com/emr-cm/_usersSettings/tokens → **New Token**
   - Scopes: **Custom defined → Show all scopes** e marque **Work Items: Read & write** e **Extension Data: Read & write** (a segunda faz os itens aparecerem na lista do Work Session Hub)
   - Copie e cole no app. Ele fica guardado criptografado (DPAPI) só para o seu usuário do Windows.
3. Arraste no calendário para criar sessões, clique numa sessão para editar/excluir, ▶ para iniciar um timer.
4. Fechar a janela encerra o app.

Dica: clique com o botão direito no .exe → **Enviar para → Área de trabalho (criar atalho)**.

## Atualizar
Quando sai uma versão nova, aparece um aviso verde no topo da janela. Clique em **Atualizar agora**: o app baixa, confere e reabre sozinho. Em **⚙ Configurações → Procurar atualizações** dá para verificar na hora.

Para publicar uma versão (quem mantém o repositório): `git tag v1.2.0 && git push origin v1.2.0`. O GitHub gera o .exe e a release.

## Onde ficam os dados
- Configuração (token criptografado): `%APPDATA%\ApontadorHoras\config.json`
- Log: `%LOCALAPPDATA%\ApontadorHoras\app.log`
- As sessões são gravadas no próprio work item (`Custom.WorkSessionEntry` e `Custom.ActualHours`), no mesmo formato da extensão.

## Código-fonte (pasta `fonte`)
- `server.js`: servidor local (127.0.0.1:47321), cofre do token e proxy para o Azure DevOps.
- `ui/index.html`: interface (calendário).
- Recompilar: `npm i -g @yao-pkg/pkg`, depois `node build.js` e `pkg . -t node22-win-x64 --options use-system-ca --no-bytecode --public-packages "*" --public -o dist/ApontadorHoras.exe`.
- Para testar sem compilar: `node build.js && node server.js` (abre a janela do Edge).

## Se não abrir
Abra o Prompt de Comando e rode:
```
C:\ApontadorHoras\ApontadorHoras.exe --debug
```
O console fica aberto mostrando o que acontece (o mesmo conteúdo vai para o `app.log`).

## Sincronizar o Clockin com o Apontador
1. Instale a extensão **Tampermonkey** no Chrome. Em `chrome://extensions` → Tampermonkey → **Detalhes**, ligue **Permitir scripts de usuário**.
2. No Tampermonkey: abra (ou crie) o script, apague o conteúdo, cole o arquivo `clockin-importar.user.js` e salve (Ctrl+S). Versão atual: 1.1.0.
3. Deixe o **ApontadorHoras.exe aberto** e entre em https://clockin.intranet.premiersoft.net/timer
4. Clique em **⇅ Sincronizar com o Apontador**, escolha a semana e confira o plano de cada dia:
   - **= igual**: já está certo, nada muda.
   - **✎ editar**: um apontamento do Clockin é ajustado (horário/descrição) para ficar igual ao Apontador.
   - **＋ criar**: sessão que existe no Apontador e falta no Clockin.
   - **✕ excluir**: apontamento do projeto que não existe no Apontador (apaga de vez).
   - **🔒 travado**: período bloqueado no Clockin, não dá para alterar.
   - Dias sem sessões no Apontador e apontamentos de outros projetos não são alterados.
5. Desmarque o que não quiser e clique em **Aplicar**. No fim ele compara de novo e mostra o resultado.
