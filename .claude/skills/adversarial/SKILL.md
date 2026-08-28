---
name: adversarial
description: Revisão adversarial de uma etapa da task ativa — despacha o agente adversarial-reviewer contra o plano, o código ou o deploy, tria os achados confirmando cada um, e registra o resultado no 30-review.md. Use quando o usuário digitar /adversarial, quando uma etapa parecer pronta, ou antes de declarar a task entregue.
---

# /adversarial — revisar uma etapa antes de confiar nela

"Parece pronto" é o estado mais perigoso de uma task. Este fluxo submete UMA etapa a um ataque deliberado antes de você construir em cima dela.

## Fluxo

1. **Identifique a etapa-alvo** da task ativa (sem task ativa na conversa, resolva primeiro). Três alvos possíveis — escolha pelo momento, com default explícito:
   - **plano** (`10-plano.md`) — logo após planejar, antes de executar;
   - **código** (`workspace/<repo>/`) — após implementar, antes de deployar;
   - **deploy** (manifests + estado real no minikube) — após o rollout, antes de declarar entregue.
   Se o usuário não especificou, proponha a etapa mais recente concluída como default.
2. **A revisão é por nó da DAG**: localize o(s) nó(s) que cobrem a etapa-alvo (`node tools/dag.mjs show <repo> <task>`) e seus guardrails anexados — a `verificacao` de cada guardrail no pool é o roteiro do ataque.
3. **Despache o agente `adversarial-reviewer`** com um briefing preciso: qual o alvo, onde vive (caminhos absolutos), quais os critérios de aceite do `00-enunciado.md` (cole-os no prompt — o agente ataca contra eles), os guardrails do(s) nó(s) com as verificações coladas (id + `verificacao`), e qualquer suspeita sua ("desconfio da probe", "o teste de X me parece fraco"). Um alvo por despacho — revisão de tudo-ao-mesmo-tempo dilui o ataque.
4. **Triagem — nenhum achado passa sem confirmação sua**: para cada achado do relatório, verifique a evidência (releia o trecho, rode o comando citado). Classifique:
   - **confirmado** → decide com o usuário: corrigir agora ou aceitar como risco (sob tempo-alvo apertado, `[BAIXA]` quase sempre é risco aceito — diga isso);
   - **refutado** → registre por quê (evidência insuficiente ou leitura errada do agente);
   - achado "não verificado — hipótese" do agente: verifique você antes de classificar.
5. **Registre o veredito por guardrail na DAG**: `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> pass|falha --nota "evidência em uma linha"`. Falha que o humano decidir não corrigir → `node tools/dag.mjs guardrail <repo> <task> <nodeId> <gid> aceito --aceitar "motivo"` — e o motivo entra também no `30-review.md`. Guardrail pendente/falha trava o `node-status concluida` do nó, por design.
6. **Registre em `30-review.md`** da task — acumulativo, uma seção por revisão. O texto gravado é lido por terceiros: voz neutra de trabalho, sem vocabulário de avaliação nem nomes de agentes como papéis do processo:
   - `## Revisão independente — <etapa> — <hh:mm>`
   - tabela: achado · severidade · status (**corrigido** / **aceito como risco** / **refutado**) · evidência ou motivo em uma linha;
   - a lista "não refutado" do agente entra com o conteúdo técnico como está — é o lastro de confiança da etapa.
   Registre também os achados **confirmados** no bus: `node tools/bus.mjs post <repo> <task> --from piloto --to humano --kind report "revisão adversarial <etapa>: N confirmados (X ALTA) — <resumo em uma linha>"` — a Sala do viewer é o registro vivo da revisão.
7. **Correções são do piloto**: aplique você (ou delegue ao executor apropriado — `test-runner` para reconferir a suíte, `k8s-operator` para re-aplicar manifest), nunca ao adversarial-reviewer. Após corrigir achado `[ALTA]`, re-despache o ataque só naquele ponto para confirmar que fechou — e atualize o guardrail correspondente para `pass`.
8. Feche com o veredito na conversa em uma linha: "etapa X: N achados (A corrigidos, B aceitos, C refutados) — pode construir em cima" ou "achado ALTA aberto: <qual> — resolver antes de seguir".

Anote no `20-journal.md` que a revisão aconteceu e o custo em minutos, em voz de trabalho ("revisão independente do deploy — N min"): revisar consome tempo-alvo, e a decisão de gastá-lo é parte do que a retrospectiva olha.
