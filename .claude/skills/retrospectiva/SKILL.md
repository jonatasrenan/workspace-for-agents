---
name: retrospectiva
description: Avalia a execução de uma task contra os 4 critérios do estúdio (decomposição, delegação e escolha de ferramentas de IA, alavanca de velocidade, tomada de decisão), com nota 1-5 por critério ancorada no journal e no git log, lacunas e plano de melhoria em 30-review.md. Use quando o usuário digitar /retrospectiva, ao fechar uma task, ou pedir "como fui?".
---

# /retrospectiva — avaliar a execução contra os 4 critérios

Retrospectiva serve para melhorar a próxima execução. Nota inflada destrói o propósito — seja rigoroso; a régua é "esta execução se sustentaria sob revisão crítica de um colega sênior?".

## Evidências (colete antes de opinar)

1. Resolva a task-alvo (a ativa; senão liste e pergunte com default na mais recente).
2. Leia `20-journal.md` (linha do tempo, delegações, estado real vs planejado), `00-enunciado.md` (critérios de aceite e cronograma prometido) e a Sala da task (`node tools/bus.mjs read <repo> <task>`) — o journal e as mensagens do bus são as fontes primárias de evidência da colaboração.
3. `git -C workspace/<repo> log --oneline --stat` — o ritmo dos commits é evidência objetiva: em quanto tempo saiu o primeiro commit? Commits pequenos e frequentes ou um commitão no fim? Mensagens dizem a intenção?
4. Estado final: quais critérios de aceite do enunciado foram verificados como atendidos (o journal deve dizer; se não disser, isso já é lacuna de processo).
5. Custo de tokens da task: some o `costs.jsonl` da task (alimentado por `tools/costs.mjs` a cada delegação) — total e por agente. Custo × resultado é evidência objetiva do critério 3.
6. DAG da task (`node tools/dag.mjs show <repo> <task>`): nós, deps, guardrails anexados, % de nós concluídos e guardrails `aceito` com seus motivos — evidência objetiva dos critérios 1 e 4.

## Os 4 critérios — nota 1-5, cada uma com evidência citada

Para cada critério: **nota**, **evidência** (citação do journal com hora, hash de commit, achado concreto — nunca impressão), **lacuna principal** (o que um revisor exigente esperaria e não viu, específico).

1. **Decomposição** — o problema virou partes atacáveis com ordem consciente? A DAG é a evidência objetiva: nós bem fatiados (nem monólito, nem migalha)? `depends_on` refletindo dependências reais, não uma fila linear? guardrails pertinentes anexados a cada nó? E o % de nós concluídos ao fim. Régua: 5 = plano em minutos, fatias com critério de pronto, replanejou quando a realidade bateu; 3 = plano existe mas fatias grandes/ordem escondeu risco; 1 = mergulhou no código sem plano, integração descoberta no fim.
2. **Delegação e escolha de ferramentas de IA** — delegou a tarefa certa ao executor certo, com briefing que permitia trabalho autônomo? Régua: 5 = delegações paralelas quando independentes, briefings com contexto e critério de sucesso, conferiu resultados antes de construir em cima; 3 = delegou, mas serializado ou com briefing vago que exigiu retrabalho; 1 = fez na mão o que executor faria melhor, ou delegou e confiou cegamente.
3. **IA como alavanca de velocidade** — a IA acelerou de verdade? Compare o relógio: quanto tempo entre "problema detectado" e "causa encontrada" quando delegou o diagnóstico vs quando leu log na mão. Régua: 5 = tempo-alvo da task respeitado, esperas ocupadas com trabalho paralelo; 3 = alavanca em parte do fluxo, mas gargalos manuais evitáveis; 1 = IA usada como autocomplete, tempo-alvo estourado sem decisão. Cite o custo total de tokens da task como evidência: alavanca boa é resultado entregue com custo proporcional; tokens queimados em retrabalho/briefing vago contam contra.
4. **Tomada de decisão** — decisões sob incerteza foram rápidas, registradas e defensáveis? Cortes de escopo conscientes (registrados) contam a favor; indecisão prolongada e retrabalho por decisão adiada contam contra. Guardrail marcado `aceito` sem correção é decisão consciente **se o motivo registrado sustenta** (risco improvável no escopo da task, corte defensável) — e conta contra se for desculpa ("sem tempo", "depois eu vejo"). A defesa das escolhas ao final se sustenta? Régua: 5 = decisões com trade-off explícito na hora certa; 3 = decisões razoáveis porém tardias ou não registradas; 1 = deriva.

## Registro

1. Acrescente em `30-review.md` a seção `## Retrospectiva — <data hh:mm>` — o texto gravado é lido por terceiros: use os títulos neutros do template (Decomposição do problema / Escolha e delegação de ferramentas de IA / IA como alavanca de velocidade / Tomada de decisão) e nunca vocabulário de avaliação ("nota do avaliador", "o que será observado") fora da tabela:
   - tabela: critério · nota · resumo de uma linha;
   - por critério: evidência e lacuna;
   - **Plano de melhoria**: 2-4 itens priorizados e acionáveis na próxima execução ("despachar log-reader ao primeiro CrashLoopBackOff em vez de ler dump", não "delegar mais");
   - veredito honesto de uma linha, em voz neutra (ex.: "a entrega sustenta revisão crítica? sim/não, por quê").
2. **Sugira itens para o `learnings.md` da raiz**: cada lacuna recorrente ou custosa vira item `aberto` ligado à task; padrão antes aberto que foi demonstrado com solidez nesta execução é promovido a `dominado` citando a task como evidência. Não duplique — atualize itens existentes. Proponha a lista e aplique salvo objeção.
3. Resuma o veredito na conversa em 3-4 linhas: nota por critério, o ponto mais forte, o ajuste de maior retorno para a próxima.
