# budget-tools

Tools for [ZenMoney](https://zenmoney.ru) and [Zerro](https://zerro.app) (envelope budgeting on top of
ZenMoney): libraries, two CLIs and two MCP servers. TypeScript run directly by Node ≥ 22.18 (type
stripping) — no build step: what the tests run is what ships.

```
packages/
  zenmoney/      @tihonove/zenmoney     API client, sqlite mirror, object builders · bin `zm`
  zerro/         @tihonove/zerro        Zerro's model inside ZenMoney: storage, envelopes, math, goals, edits · bin `zerro`
  mcp-zenmoney/  @tihonove/mcp-zenmoney MCP server: accounts, categories, transactions
  mcp-zerro/     @tihonove/mcp-zerro    MCP server: months, budgets, goals, envelope settings
  mcp-kit/       (internal) per-token sessions, Streamable HTTP and stdio
  cli-kit/       (internal) CLI plumbing on commander
  testing/       (internal) fake ZenMoney API, sandboxes, fixtures, live-test guard, MCP test client
deploy/          kustomize for the cluster (two Deployments, one Ingress, no secrets)
Dockerfile       one file, two images: --build-arg APP=mcp-zenmoney | mcp-zerro
```

Dependencies go one way: `mcp-* → zerro → zenmoney`, CLIs use `cli-kit`. The libraries know nothing
about MCP or HTTP; MCP tools and CLI commands are thin layers over the same functions.

## CLIs

```bash
npm install
npx zm auth                     # token from https://zerro.app/token → .secrets/token
npx zm sync && npx zm accounts
npx zerro show                  # this month as Zerro shows it
npx zerro budget Groceries 600   # writes go: sync → build → push → verify on the server
```

`zm --help`, `zerro --help`, `<command> --help`. Write commands take `--dry-run` (print the payload).
Configuration: `ZENMONEY_DB` (default `./zenmoney.db`), `ZENMONEY_TOKEN` or `ZENMONEY_TOKEN_FILE`
(default `./.secrets/token`), `ZENMONEY_API`.

## MCP servers

Each server keeps a sqlite mirror per user, synced when older than a minute; calls of one user run
one at a time. Write tools change real data and are annotated as such.

**Over HTTP** (deployed): the ZenMoney token is sent with every request —
`Authorization: Bearer <token>` or `X-ZenMoney-Token: <token>`. The server checks it with ZenMoney,
names the user's mirror by the token's SHA-256 and never stores or logs the token. Without a valid
token: 401. Endpoint `POST /mcp` (stateless Streamable HTTP), probe `GET /healthz`.

```jsonc
// .mcp.json (Claude Code)
{
    "mcpServers": {
        "zenmoney": {
            "type": "http",
            "url": "https://zenmoney-mcp.tihonove.dev/mcp",
            "headers": { "Authorization": "Bearer ${ZENMONEY_TOKEN}" },
        },
        "zerro": {
            "type": "http",
            "url": "https://zerro-mcp.tihonove.dev/mcp",
            "headers": { "Authorization": "Bearer ${ZENMONEY_TOKEN}" },
        },
    },
}
```

**Over stdio** (local, one user, configured like the CLIs):
`node packages/mcp-zenmoney/bin/stdio.ts`, `node packages/mcp-zerro/bin/stdio.ts`.

Server settings: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR` (./data), `ZENMONEY_API`.

## Tests

| command                 | what                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `npm test`              | unit and in-process tests: fake API, temp mirrors, no network     |
| `npm run test:coverage` | the same with coverage and a ratchet (CI fails if coverage drops) |
| `npm run test:mutation` | Stryker, then every survivor re-checked by injection (the gate)   |
| `npm run test:live`     | contract tests against a real ZenMoney **test** account           |
| `npm run typecheck`     | `tsc` strict, erasable syntax only                                |
| `npm run format:check`  | Prettier                                                          |

The target is 100% coverage and 100% verified mutation score. Ignores (`/* v8 ignore */`,
`// Stryker disable`) are only for process glue that runs in a subprocess (bin scripts, real stdin,
interactive prompts) and carry the reason next to them.

Mutation runs can be scoped: `STRYKER_MUTATE=packages/zerro/src/calc.ts,packages/zerro/src/ops.ts`.
Stryker with vitest reports phantom survivors (different ones each run), so `scripts/verify-mutants.mjs`
re-checks each survivor by applying the mutant to a copy of the repo and running its tests.

Live tests need `ZENMONEY_TEST_TOKEN` (or `ZENMONEY_TEST_TOKEN_FILE`) and `ZENMONEY_TEST_USER_ID`; they
refuse to run if the token belongs to anyone else, and clean up what they create.

## Deploy

Images `ghcr.io/tihonove/mcp-zenmoney` and `ghcr.io/tihonove/mcp-zerro` (amd64 + arm64) are built by
`.github/workflows/release.yml` on pushes to main, tagged with the commit SHA; the workflow then sets
the tags in `deploy/kustomization.yaml` and commits. The cluster (Flux, see
[tihonove.dev-apps](https://github.com/tihonove/tihonove.dev-apps/blob/main/GUIDE.md)) applies `deploy/`.
New GHCR packages are private: make them public once after the first push.

Zerro's data format follows [ardov/zerro](https://github.com/ardov/zerro) at `be47283` (2026-09-01).
