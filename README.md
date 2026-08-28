# Workspace for Agents

Estúdio para conduzir trabalho técnico delegando a uma equipe de subagentes de IA — e enxergar a colaboração enquanto ela acontece.

Cada desafio vira um **repo**; cada repo tem **tasks**; cada task tem uma **DAG** de subtarefas com guardrails anexados. Mensagens entre o piloto e os agentes, logs de operação, custo em tokens, commits e diffs são registrados em arquivos e renderizados por um painel local que se atualiza sozinho.

O harness é [Claude Code](https://claude.com/claude-code): `CLAUDE.md` instrui o agente-piloto, e `.claude/agents/` traz os executores especializados. As ferramentas em `tools/` são Node puro — **zero dependências npm**, nada para instalar.

## Como funciona

- **Você fala em linguagem natural.** "Novo desafio sobre X", "vamos trabalhar na task 02", "como fui?". O piloto mapeia a intenção nos comandos e conduz.
- **O piloto não executa braçal.** Operar cluster, ler logs e métricas, rodar testes e revisar vão para os subagentes de `.claude/agents/`; frentes independentes saem em paralelo.
- **Toda delegação deixa rastro.** Cada ciclo de agente é postado no bus da task (`spawned` → `working` → `done`) e o custo em tokens é registrado — o painel mostra a colaboração em tempo real.
- **Estado é push.** Quem faz uma operação registra o resultado; o viewer renderiza o que está gravado em `repos/<repo>/`. Por conta própria ele faz só duas coisas: pinga as URLs já registradas em Acessos (para mostrar se estão de pé) e lê o git de `workspace/<repo>/` para montar a aba Diff.
- **Código fica separado.** O código de cada desafio vive em `workspace/<repo>/`, um repositório git próprio e limpo, fora do versionamento deste harness.

## Requisitos

- **Node.js 20.13+** (desenvolvido em 24.x). Nenhuma dependência npm. As ferramentas de `tools/` rodam em Node 18, mas o viewer usa `fs.watch` recursivo, que no Linux só existe a partir do 20.13 — abaixo disso o painel funciona, porém não se atualiza sozinho.
- **git** — `new-repo.mjs` inicializa o repositório de cada desafio e a aba Diff lê o histórico do workspace.
- Um agente que leia `CLAUDE.md` e `.claude/` — o projeto é escrito para o Claude Code.
- Opcionais, só para os desafios de exemplo: Docker e minikube (os agentes `k8s-operator`, `log-reader` e `metrics-reader` operam sobre eles). O motor do estúdio não depende de Kubernetes.
- Opcional, só para publicar um repo como página: AWS CLI com acesso a um bucket S3 e a uma distribuição CloudFront.

## Primeiros passos

```sh
git clone https://github.com/jonatasrenan/workspace-for-agents.git
cd workspace-for-agents

# 1. crie um desafio: repos/<slug>/ (metadados) + workspace/<slug>/ (git init)
node tools/new-repo.mjs "Meu desafio"

# 2. crie a primeira task: enunciado, plano, journal e review a partir de templates
node tools/new-task.mjs meu-desafio "Deploy inicial"

# 3. abra o painel (só loopback; PORT e HOST podem ser sobrescritos por env)
node viewer/server.mjs     # http://localhost:4500
```

`repos/` e `workspace/` são ignorados pelo git: são o **seu** estado, não o motor. Um clone novo começa vazio — o painel abre sem repos até você criar o primeiro.

A partir daí, converse com o agente. Quando ele planejar a task, a decomposição é gravada como DAG; conforme executa, mensagens, logs e custos aparecem no painel.

## O painel

`node viewer/server.mjs` sobe em `http://localhost:4500`, escutando só em `127.0.0.1`. Traz, por task: **Sala** (mensagens do bus), **DAG** (nós e guardrails, ao vivo), **Logs**, **Custos**, **Diff** (os commits registrados na task, mais os do período em que ela esteve aberta) e **Linha do tempo**, além dos arquivos da task; e, por repo, uma **Visão geral** com o roster de agentes, acessos, runtime e progresso. As mudanças de arquivo chegam por SSE — não precisa recarregar.

Quando um agente faz uma pergunta ao humano, você responde pelo próprio painel (ele posta no bus) ou pela conversa.

## Ferramentas

Todas rodam a partir da raiz do projeto, sem argumentos mágicos:

| Operação | Comando |
|---|---|
| Criar repo | `node tools/new-repo.mjs "<Título>" [--slug <slug>]` |
| Criar task | `node tools/new-task.mjs <repo> "<Título>" [--depends-on "01,02"]` |
| Mensagem no bus (Sala) | `node tools/bus.mjs post <repo> <task> --from X --to Y --kind report\|question\|decision\|approval\|status "corpo"` |
| Log operacional | `node tools/bus.mjs log <repo> <task> --level debug\|info\|warn\|error --source S "corpo"` |
| Ler mensagens | `node tools/bus.mjs read <repo> <task> [--to X] [--kind K] [--since ISO] [--tail N]` |
| Agentes que atuaram | `node tools/bus.mjs agents <repo> [<task>]` |
| Registrar tokens | `node tools/costs.mjs add <repo> <task> --agente X (--in N --out N \| --total N) [--modelo m] [--label "..."]` |
| Relatório de custos | `node tools/costs.mjs report [<repo> [<task>]]` |
| Gravar a DAG | `node tools/dag.mjs set <repo> <task>` (stdin = JSON) |
| Status de um nó | `node tools/dag.mjs node-status <repo> <task> <nodeId> todo\|executando\|concluida\|bloqueada [--force]` |
| Veredito de guardrail | `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> pass\|falha\|pendente [--nota "..."]` — falha aceita: `... aceito --aceitar "motivo"` |
| Catálogo de guardrails | `node tools/dag.mjs pool [--tag t] [--categoria c]` |
| Ver / validar DAG | `node tools/dag.mjs show <repo> <task>` · `validate <repo> <task>` |
| Registrar commit na task | `node tools/commits.mjs add <repo> <task> <hash> [--msg "..."]` · `list <repo> <task>` |
| Acessos (URLs) do repo | `node tools/acessos.mjs add\|remove\|list <repo> [...]` |
| Estado vivo do repo | `node tools/estado.mjs set <repo> runtime\|ambiente\|origem` (stdin = JSON) · `show <repo>` |
| Publicar um repo | `node tools/share.mjs <repo> [--dry-run\|--off\|--delete\|--sem-custos]` |

## Guardrails

`guardrails/pool.json` é um catálogo de verificações reutilizáveis (cada uma com `aplica_a` e um comando/observação que a comprova). Ao montar a DAG, o piloto anexa a cada nó os guardrails cujo `aplica_a` casa com as tags do nó. Um nó só fecha como `concluida` quando seus guardrails estão resolvidos — uma falha pode ser explicitamente **aceita**, com motivo registrado.

## Publicar um repo como página

`tools/share.mjs` gera uma página estática com o mesmo painel (um repo só, somente leitura) e envia para S3 + CloudFront. É opcional e exige a **sua** infraestrutura:

```sh
cp .env.example .env    # bucket, distribuição, URL base, perfil e região da AWS
node tools/share.mjs meu-desafio --dry-run   # gera o HTML no diretório temporário, sem tocar a AWS
node tools/share.mjs meu-desafio             # publica
```

Sem as variáveis configuradas, o comando falha dizendo exatamente o que falta. Enquanto o share estiver ativo, o viewer republica a página sozinho a cada mudança do repo; `--off` pausa a republicação (a página segue no ar) e `--delete` tira do ar — este último também precisa das credenciais AWS.

## Estrutura

```
workspace-for-agents/
├── CLAUDE.md              # instruções do agente-piloto
├── learnings.md           # memória entre tasks (itens aberto/dominado)
├── .claude/
│   ├── agents/            # executores: k8s-operator, log-reader, metrics-reader,
│   │                      # test-runner, adversarial-reviewer
│   └── skills/            # fluxos: refinar, adversarial, retrospectiva
├── guardrails/pool.json   # catálogo de verificações reutilizáveis
├── tools/                 # ferramentas Node (sem dependências)
├── viewer/                # painel web local (porta 4500); vendor/ traz marked e mermaid
├── .env.example           # configuração de publicação (copie para .env)
├── repos/<repo>/          # seu estado: contexto, tasks, bus, custos, DAG  (git-ignored)
└── workspace/<repo>/      # o código de cada desafio, repo git próprio      (git-ignored)
```

## Licença

MIT — veja [LICENSE](LICENSE). As bibliotecas de terceiros em `viewer/public/vendor/` mantêm suas próprias licenças MIT, documentadas em [viewer/public/vendor/README.md](viewer/public/vendor/README.md).
