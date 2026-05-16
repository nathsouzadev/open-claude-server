# claude-workspace

Workspace portátil para replicar minha configuração do Claude Code em qualquer máquina (sem secrets versionados).

## O que tem aqui

```
claude-workspace/
├── claude-config/          # vai virar ~/.claude/
│   ├── CLAUDE.md           # instruções globais
│   ├── RTK.md              # referência do rtk
│   ├── nestjs-CLAUDE.md    # docs auxiliares
│   ├── nextjs-CLAUDE.md
│   ├── settings.example.json   # settings.json com __HOME__ como placeholder
│   ├── mcp.example.json        # template para MCPs custom
│   └── hooks/                  # 3 hooks: rtk, project-lines-metric, context-mode-cache-heal
├── skills/user/            # skills custom (atualmente vazio)
├── projects.yml            # lista de projetos para clonar
├── setup.sh                # bootstrap idempotente
├── .gitignore              # ignora projects/*/, .env, credentials, *.key, *.pem
└── projects/               # gitignored — populado pelo setup.sh
```

## Uso em máquina nova

```bash
git clone <este-repo> claude-workspace
cd claude-workspace
./setup.sh
```

O script:
1. Pergunta antes de sobrescrever qualquer arquivo em `~/.claude/`.
2. Substitui `__HOME__` no `settings.json` pelo `$HOME` real da máquina.
3. Copia hooks para `~/.claude/hooks/` e dá `chmod +x`.
4. Clona cada projeto de `projects.yml` em `./projects/<name>` (pula se já existe).
5. Cria versão sem `.example` para qualquer `*.example` cujo destino ainda não exista.
6. Lista quais `.env` precisam ser preenchidos e quais binários externos faltam.

## Dependências

Necessárias para rodar `setup.sh`:

- `git`, `yq`, `jq`

Necessárias em runtime (após o setup, para os hooks funcionarem):

- `rtk` ≥ 0.23.0 — https://github.com/rtk-ai/rtk
- `jq`
- `python3`
- `node`
- (opcional) OTel collector em `localhost:4318` para receber métricas

## Plugins do Claude Code

Já declarados em `settings.example.json` (`enabledPlugins` + `extraKnownMarketplaces`):

- `code-review-graph` (tirth8205/code-review-graph)
- `context-mode` (mksglu/context-mode)
- `superpowers` (obra/superpowers-marketplace)
- `claude-mem` (thedotmack/claude-mem)

Se o Claude Code não resolver os marketplaces sozinho, o `setup.sh` imprime os comandos `/plugin marketplace add` + `/plugin install` para rodar dentro da CLI.

## Primeiro uso em máquina nova

Setup completo do zero, com Docker:

```bash
git clone <repo> claude-workspace
cd claude-workspace
./setup.sh        # clona projetos, copia config pra ~/.claude/, oferece build Docker
make up           # sobe o container
make shell        # entra no container
# dentro do container, daqui pra frente:
#   - claude já autentica (auth do host montado read-only)
#   - cd /workspace/projects/<nome> e trabalha normalmente
```

Auth: o container reusa `~/.claude/.credentials.json` do host (read-only). Não precisa rodar `claude login` separado. Se algum dia o token expirar e o refresh falhar dentro do container, faça login no host (fora do container) e reinicie com `make down && make up`.

## Uso com Docker (opcional)

Ambiente Claude Code containerizado, isolado, com auth e SSH do host reusados.

**Pré-requisitos**: Docker Desktop (ou Docker Engine + Compose v2).

```bash
make build    # builda a imagem (Node 22 + Python 3 + Claude Code CLI)
make up       # sobe em background
make shell    # bash dentro do container
make down     # para
make clean    # para e remove volumes
```

Dentro do container você cai em `/workspace` com `projects/` montado, `claude` no PATH, SSH e `.gitconfig` do host disponíveis. O auth do Claude Code é montado **read-only** a partir de `~/.claude/.credentials.json` do host — não precisa logar de novo.

Mounts (`docker/docker-compose.yml`):

| Host | Container | Modo |
|---|---|---|
| `claude-config/` | `/home/claude/.claude` | rw |
| `~/.claude/.credentials.json` | `/home/claude/.claude/.credentials.json` | ro |
| `skills/user/` | `/home/claude/.claude/skills/user` | rw |
| `projects/` | `/workspace/projects` | rw |
| `~/.gitconfig` | `/home/claude/.gitconfig` | ro |
| `~/.ssh/` | `/tmp/host-ssh` (copiado pelo entrypoint) | ro |

UID/GID do usuário `claude` no container = **501** (alinhado com macOS, default deste setup). Se seu host for Linux com UID diferente, sobrescreva via `docker compose build --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)`.

Pra expor portas de dev server, descomente o bloco `ports:` em `docker/docker-compose.yml`.

## Server HTTP

Wrapper REST do Claude Code rodando dentro do container, ouvindo em `127.0.0.1:3010`. Detalhes, env vars e plano pra exposição pública em [`server/README.md`](./server/README.md).

```bash
make server-up
curl -s http://127.0.0.1:3010/health | jq
curl -s -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Responda PONG"}' | jq
```

Auth e rate-limit estão **desligados** por default. Ligue antes de expor.

## Troubleshooting

**`Claude configuration file not found at: /home/claude/.claude.json`** — esperado em containers recém-criados. O entrypoint restaura automaticamente do backup mais recente em `claude-config/backups/`. Se a mensagem persistir, verifique se há algum backup ali. Não bloqueia o uso.

**`git@github.com: Permission denied (publickey)`** — sua chave SSH (`~/.ssh/id_rsa`) não está autorizada no GitHub. Não é problema do container — o host tem o mesmo comportamento. Use HTTPS pra clonar repos privados ou registre a chave em https://github.com/settings/keys.

**Permission denied em `.ssh/`** — o entrypoint copia `~/.ssh` do mount read-only pra `/home/claude/.ssh` com perms 600/700. Se falhar, cheque se as chaves existem no host (`ls ~/.ssh/id_*`) e se o mount em `docker-compose.yml` aponta pro `${HOME}/.ssh` correto.

**Claude pede login toda vez** — o mount de `~/.claude/.credentials.json` (read-only) deve estar funcionando. Verifique:
```bash
make shell
ls -la /home/claude/.claude/.credentials.json   # deve mostrar 472B, owner claude
```
Se faltar, confirme que o arquivo existe no host e que o `${HOME}` foi resolvido corretamente no compose.

**`git push` falha do container** — depende do método: HTTPS com credential helper do macOS não funciona dentro do container (helper é binário macOS). Use SSH ou um PAT em URL.

**`useradd warning: claude's uid 501 outside of the UID_MIN 1000`** — cosmético. Em macOS o usuário do host é UID 501; alinhamos pra evitar problemas de perms em arquivos criados pelo container vistos do host.

**Arquivo gerado dentro do container aparece como `nobody` ou root no host** — UID mismatch. Rebuild com `docker compose build --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g)`.

## Segurança

- `.gitignore` bloqueia `projects/*/`, `.env`, `credentials`, `*.key`, `*.pem`.
- `claude-config/.credentials*`, `claude-config/auth*`, sessões e caches gerados pelo Claude Code dentro do container **não** são versionados (gitignored).
- Nenhum token, oauth ou API key é versionado. Arquivos sanitizados:
  - `settings.example.json` (paths absolutos viraram `__HOME__`).
  - `projects.yml` (PAT removido do remote do `inclient` — **revogue o token original**).
- `.credentials.json`, `.claude.json` e caches do `~/.claude/` **não** são copiados pro repo.
