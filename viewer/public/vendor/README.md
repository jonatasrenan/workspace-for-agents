# Dependências de terceiros (vendored)

O viewer não tem `package.json`: estas duas bibliotecas são servidas do próprio
repositório para que o painel funcione offline e sem `npm install`. Ambas foram
baixadas do cdnjs e não têm nenhuma modificação local — os SHA-256 abaixo batem,
byte a byte, com os arquivos publicados no CDN.

| Arquivo | Biblioteca | Versão | Licença | Origem | SHA-256 |
|---|---|---|---|---|---|
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js | `15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894` |
| `mermaid.min.js` | [mermaid](https://github.com/mermaid-js/mermaid) | 10.9.1 | MIT | https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js | `61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6` |

Para conferir ou atualizar:

```sh
shasum -a 256 viewer/public/vendor/*.js
curl -sSLO https://cdnjs.cloudflare.com/ajax/libs/mermaid/<versão>/mermaid.min.js
```

As licenças MIT de ambas as bibliotecas se aplicam aos respectivos arquivos; o
restante deste repositório é coberto pelo `LICENSE` da raiz.
