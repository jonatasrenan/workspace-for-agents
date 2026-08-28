---
name: refinar
description: Refina o enunciado de uma task — aperta objetivo, requisitos, critérios de aceite mensuráveis e tempo-alvo com marcos intermediários — e reescreve o 00-enunciado.md. Use quando o usuário digitar /refinar, criar uma task nova, ou reclamar que um enunciado está vago.
---

# /refinar — apertar o enunciado de uma task

Um enunciado vago mata a task antes de começar: sem critério mensurável não há como delegar bem nem saber se acabou. Este fluxo transforma `00-enunciado.md` num contrato executável.

## Fluxo

1. **Resolva a task-alvo**: a ativa na conversa; senão liste `repos/*/tasks/*/` e pergunte (com a mais recente como default). Leia o `00-enunciado.md` atual e dê uma olhada no `workspace/<repo>/` (README, estrutura) para calibrar o que é realista dentro do tempo-alvo naquele código.
2. **Diagnostique as lacunas** do enunciado atual, nesta ordem de importância:
   - **Objetivo**: dá para dizer em uma frase o que estará rodando ao final? Se não, essa é a primeira coisa a fechar.
   - **Critérios de aceite**: cada um precisa ser **verificável por comando ou observação direta** ("`curl` no endpoint /X retorna 200 com payload Y", "pod sobrevive a `kubectl delete pod`", "suíte passa"), nunca "código limpo" ou "bem estruturado".
   - **Requisitos e restrições**: o que é obrigatório usar (Docker? minikube? linguagem do repo?) e o que está explicitamente fora de escopo.
   - **Critérios de qualidade do processo**: os 4 critérios do estúdio (decomposição, escolha/delegação de ferramentas de IA, IA como alavanca de velocidade, tomada de decisão) traduzidos para ESTA task como critérios de trabalho neutros e verificáveis — ex.: "decisões de escopo registradas no journal com justificativa". No enunciado gravado, nunca vocabulário de avaliação ("o que será observado", "nota").
3. **Cheque o tamanho antes de refinar**: se o escopo pedido não couber no tempo-alvo ou contiver entregas de natureza distinta, proponha (com default recomendado) a quebra em múltiplas tasks encadeadas em vez de inflar uma só — crie-as via `node tools/new-task.mjs <repo> "<Título>" --depends-on <task-anterior>` e refine cada enunciado no seu próprio arquivo, começando pela primeira da cadeia.
4. **Monte o cronograma-alvo** com marcos — proporcionais ao tempo-alvo da task, este esqueleto é para uma task de ~60 min:
   - **1/4 do tempo**: decomposição feita, plano registrado, primeira delegação despachada;
   - **1/2 do tempo**: núcleo funcional rodando local (teste ou execução direta);
   - **2/3 do tempo**: algo de ponta a ponta no ambiente-alvo, ainda que mínimo — se não houver, corte escopo aqui;
   - **3/4 do tempo**: critérios de aceite sendo verificados um a um;
   - **fim**: entrega + registro das decisões que sustentam o resultado.
5. **Proponha a versão refinada inteira** (não pergunte campo a campo): reescreva o enunciado completo com defaults marcados onde você assumiu ("tempo-alvo: 60 min (assumido)"). Aplique direto em `00-enunciado.md` salvo objeção — o usuário só intervém no que discordar.
6. Estrutura do arquivo reescrito:
   - `# <título da task>`
   - `## Objetivo` — uma frase, estado final observável.
   - `## Requisitos` — obrigatórios e fora de escopo.
   - `## Critérios de aceite` — checklist, cada item com o comando/observação que o verifica; os critérios de qualidade do processo (item 2) entram aqui, em voz neutra, sem seção separada de observação.
   - `## Tempo-alvo e marcos` — tabela momento → estado esperado.
7. **Gere/atualize a DAG da task no mesmo gesto**: decomponha o trabalho em 4-8 nós com `depends_on`, tags e guardrails anexados do pool — consulte `node tools/dag.mjs pool [--tag t]` para casar o `aplica_a` de cada guardrail com as tags do nó. Grave via `node tools/dag.mjs set <repo> <task>` (stdin = JSON completo) e confira com `node tools/dag.mjs show <repo> <task>`. A DAG e o `10-plano.md` saem do mesmo gesto: o plano em prosa cita os nós por id.
8. Se a task já tem `10-plano.md`, avise que o enunciado mudou por baixo dele e ofereça revisar o plano (e a DAG) na sequência (default: sim).

O refinado substitui o original; se o enunciado veio de uma fonte externa, preserve o texto original num `<details>` ao final para rastreabilidade, com título neutro (ex.: "Enunciado original").
