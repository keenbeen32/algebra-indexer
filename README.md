# pumex-algebra-envio

An [Envio HyperIndex](https://docs.envio.dev) indexer for Algebra Integral,
covering two deployments:

| chain | id | factory | start block |
|---|---|---|---|
| Linea | 59144 | `0x622b2c98123D303ae067DB4925CD6282B3A08D0F` | 143,660 |
| Zircuit | 48900 | `0x03057ae6294292b299a1863420edD65e0197AFEf` | 3,709,368 |

It indexes the factory, the dynamically-registered pools, and the
NonfungiblePositionManager: pools, ticks, positions, swaps, mints, burns, and
the day/hour rollups derived from them.

## Prerequisites

- Node.js 22+
- pnpm
- Docker (for `envio dev`, which runs Postgres and Hasura locally)

## Environment variables

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored.

| variable | required | what for |
|---|---|---|
| `ENVIO_API_TOKEN` | yes | HyperSync access — create one at https://envio.dev/app/api-tokens |
| `ENVIO_RPC_URL_59144` | yes | Linea |
| `ENVIO_RPC_URL_48900` | yes | Zircuit — both the log sync and the contract reads |
| `ENVIO_RPC_URL_59144_FALLBACK` | no | second Linea endpoint, tried after the primary's retries |
| `ENVIO_RPC_URL_48900_FALLBACK` | no | second Zircuit endpoint, same |

The `_FALLBACK` variables are genuine alternate providers, not duplicates.
Retrying the primary only rescues a transient failure; a provider that cannot
serve a given historical block needs a different provider. Leave them unset and
failover is skipped.

These should be archive endpoints. Contract reads are pinned to the block of the
event that triggered them, so a pruned node answers from a later state rather
than failing. `ENVIO_RPC_URL_48900` has no default on purpose — an unset value
fails loudly rather than quietly sourcing from a short-history endpoint.

Optional: `ENVIO_EFFECT_RATE_LIMIT` — per-effect RPC rate limit. Lower it if the
provider returns 429s; the symptom is the indexer stalling with retry and
timeout errors rather than crashing.

## Running locally

```bash
pnpm install
pnpm envio codegen        # required after any config.yaml or schema.graphql edit
pnpm envio dev            # needs Docker
```

`envio dev` starts Postgres and Hasura in containers and serves GraphQL from the
Hasura console (http://localhost:8080 by default). `pnpm envio dev -r` restarts
from scratch, dropping the existing data.

```bash
npx tsc --noEmit          # typecheck
pnpm test                 # unit tests over the pure helpers, no network or database
```

CI (`.github/workflows/test.yaml`) runs codegen and `pnpm test` on pushes to
`main` and on pull requests. It needs `ENVIO_API_TOKEN` as a repository secret.

## Chain notes

**Zircuit (48900)** — syncs from RPC. The public endpoints we tested retain only
the recent blocks rather than complete log history, which is a property of those
providers rather than of this indexer. Point `ENVIO_RPC_URL_48900` at an
endpoint that serves full historical logs and it should run.

If you want to confirm an endpoint before pointing the indexer at it, this
should come back with a non-empty `result`:

```bash
curl -s -X POST -H 'content-type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{
    "fromBlock":"0x700000","toBlock":"0x702710"}]}' $ENVIO_RPC_URL_48900
```

The missing-Tick throw in `handleBurn` is fatal on purpose — it is what surfaces
a short-history endpoint rather than letting it pass quietly. Do not silence it.
