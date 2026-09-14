# Third-party dependencies (vendored)

The viewer has no `package.json`: these two libraries are served from the
repository itself so the panel works offline and without `npm install`. Both
were downloaded from cdnjs and have no local modification — the SHA-256
hashes below match, byte for byte, the files published on the CDN.

| File | Library | Version | License | Source | SHA-256 |
|---|---|---|---|---|---|
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 12.0.2 | MIT | https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js | `15fabce5b65898b32b03f5ed25e9f891a729ad4c0d6d877110a7744aa847a894` |
| `mermaid.min.js` | [mermaid](https://github.com/mermaid-js/mermaid) | 10.9.1 | MIT | https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js | `61b335a46df05a7ce1c98378f60e5f3e77a7fb608a1056997e8a649304a936d6` |

To verify or update:

```sh
shasum -a 256 viewer/public/vendor/*.js
curl -sSLO https://cdnjs.cloudflare.com/ajax/libs/mermaid/<version>/mermaid.min.js
```

The MIT licenses of both libraries apply to their respective files; the rest
of this repository is covered by the root `LICENSE`.
