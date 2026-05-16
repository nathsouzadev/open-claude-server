---
name: persistent-cron
description: Cria, lista e remove jobs cron persistentes delegando ao subagente `scheduler` (que executa a REST API do claude-server). Use SEMPRE que o usuário pedir para agendar, programar, criar cron, lembrar, executar recorrente, repetir, todo dia/hora/semana, schedule, ou qualquer disparo periódico. NUNCA use a ferramenta interna CronCreate neste ambiente — ela é session-only e não persiste. Esta skill é o único caminho persistente entre restarts do container.
---

# Persistent Cron — Agendamento via subagente `scheduler`

## Como executar a operação

**Delegue todas as chamadas HTTP ao subagente `scheduler`** via Task tool. Não execute `curl` diretamente nesta sessão — o `scheduler` roda em `model: haiku` e é o único responsável por falar com a REST API (`http://localhost:3010/api/jobs`).

Sua responsabilidade aqui:
1. Extrair do usuário: o que executar, quando, onde mandar o resultado.
2. Confirmar a interpretação (cron humano + canal).
3. Invocar `Task(subagent_type="scheduler", prompt=...)` passando a operação estruturada.
4. Retornar ao usuário o `id` (no CREATE) ou a confirmação (DELETE/LIST).

Exemplo de prompt para o `scheduler`:

> "CREATE job: expr=`0 9 * * 1-5`, agent=`nanisca`, message=`Gerar relatório diário de epics`, name=`relatório epics`, destination=`{type:slack, channel:D0B26HJ6XG8}`."

O `scheduler` devolve só o resultado mecânico (id ou erro). Você apresenta isso ao usuário em linguagem humana.

## Quando usar esta skill

Acione esta skill em qualquer pedido de agendamento, mesmo que vago:

- "agenda relatório diário às 9h"
- "todo dia útil de manhã"
- "manda esse resumo na segunda-feira"
- "executa isso a cada hora"
- "lembra de mim na sexta"
- "cron para gerar X"
- "schedule a daily report"
- "preciso que isso rode toda semana"

## Regra absoluta

**NUNCA** use a ferramenta interna `CronCreate` neste ambiente. Ela é session-only, expira quando o processo Claude encerra, e **não persiste** mesmo com `durable: true`. Toda tentativa será descartada quando a sessão fechar.

A única forma de criar cron persistente aqui é via API REST local do `claude-server`, acessível em `http://localhost:3010/api/jobs`.

## Endpoint da API (referência — quem chama é o `scheduler`)

- `POST /api/jobs` — cria
- `GET /api/jobs` — lista
- `DELETE /api/jobs/<id>` — remove

Você **não** chama esses endpoints. Apenas monte o payload e delegue ao subagente `scheduler`.

## Formato de expressão cron

5 campos no padrão Linux (sem segundos):

```
┌───────────── minuto (0-59)
│ ┌─────────── hora (0-23)
│ │ ┌───────── dia do mês (1-31)
│ │ │ ┌─────── mês (1-12)
│ │ │ │ ┌───── dia da semana (0-6, domingo=0)
│ │ │ │ │
* * * * *
```

Exemplos comuns:

| Expressão | Significado |
|---|---|
| `0 9 * * *` | Todo dia às 09:00 |
| `0 9 * * 1-5` | Dias úteis às 09:00 |
| `*/15 * * * *` | A cada 15 minutos |
| `0 */2 * * *` | A cada 2 horas (no minuto 0) |
| `0 18 * * 5` | Toda sexta-feira às 18:00 |
| `0 0 1 * *` | Primeiro dia do mês à meia-noite |
| `30 8,14 * * 1-5` | Dias úteis às 08:30 e 14:30 |

## Campos do payload

| Campo | Obrigatório | Detalhes |
|---|---|---|
| `expr` | sim | Expressão cron de 5 campos |
| `agent` | sim | Nome exato do subagente (`nanisca`, `dorothy`, etc.) |
| `message` | sim | Texto enviado ao agente no disparo |
| `name` | não | Rótulo amigável para identificar o job |
| `destination` | não | Onde mandar o resultado |
| `destination.type` | sim se houver dest. | Atualmente apenas `"slack"` |
| `destination.channel` | sim se Slack | ID do canal Slack (formato `C0123456789`) |
| `destination.bot` | não | Nome do bot Slack a usar para postar (se múltiplos bots) |

**Importante sobre `destination.channel`**: é o **ID do canal**, não o nome. Formato: `C` + 10-11 caracteres alfanuméricos. Se o usuário disser "no canal #produto", peça o ID ou explique como obter: Slack → clica no canal → "View channel details" → ID no rodapé.

## Fluxo recomendado

1. **Entenda o pedido** — extrai do usuário: o que executar, quando, onde mandar o resultado.

2. **Confirme a interpretação** antes de criar:
   > "Vou agendar: `<message>` para rodar `<descrição humana do expr>` e postar em `<canal>`. Confirma?"

3. **Crie o job** invocando `Task(subagent_type="scheduler", ...)`. Não use Bash/curl diretamente.

4. **Retorne o `id` ao usuário** para que possa remover depois:
   > "Job criado. ID: `abc-123`. Para remover: `DELETE /api/jobs/abc-123`."

5. **Sem destino?** Se o usuário não especificar canal, sugira o canal atual da conversa (se for em Slack) ou avise que o resultado irá apenas para os logs do servidor.

## Erros comuns

| Erro | Causa | Como resolver |
|---|---|---|
| `400 invalid_cron` | Expressão inválida | Reescreva com 5 campos válidos |
| `400 invalid_params` | Campo faltando ou tipo errado | Olhe o array `issues` retornado |
| `404 not_found` | ID inexistente no DELETE | Liste primeiro com `GET /api/jobs` |
| Connection refused | Server não está rodando | Avise o usuário que `claude-server` precisa estar up |

## O que NÃO fazer

- ❌ **Não use** `CronCreate` interno — descartado neste ambiente.
- ❌ **Não invente** outros endpoints (`/cron`, `/schedule`, etc.). A rota é apenas `/api/jobs`.
- ❌ **Não use** `gh` ou outros CLIs pra simular cron — a API é a única fonte de verdade.
- ❌ **Não silencie** o usuário: sempre devolva o `id` do job criado.

## Exemplo completo

Usuário: "Manda relatório diário do inclient às 9h no canal #produto-status (ID C09ABCDE12)"

Você delega:

```
Task(subagent_type="scheduler", prompt="""
CREATE job:
  expr: 0 9 * * *
  agent: nanisca
  message: Gerar relatório diário do produto inClient com PRs merged, issues abertas, bloqueios e próximos movimentos.
  name: relatório diário inclient
  destination: {type: slack, channel: C09ABCDE12}
""")
```

`scheduler` retorna o `id`. Você responde:

> Job criado: `relatório diário inclient`.
> - Quando: todo dia às 09:00
> - Destino: canal `C09ABCDE12`
> - ID: `b5e8...d31a` (use esse ID para remover depois com `DELETE /api/jobs/b5e8...d31a`)
