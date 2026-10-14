# Notes for agents and contributors

Layout, commands and the test setup are in [README.md](README.md). These are the working rules.

## Language

Everything in this repository is in English: code, comments, docs, CLI output, test names, test data
and commit messages. The only Cyrillic left is deliberate — tests of Unicode handling (case-insensitive
names, Zerro's payee cleaning) and the matching regex in `zerro/src/envelopes.ts` — and is marked as such.

## Code

- TypeScript run directly by Node ≥ 22.18 (type stripping), no build step: erasable syntax only — no
  enums, namespaces or parameter properties. Imports carry the `.ts` extension.
- Prettier formats everything (4 spaces, width 100; YAML 2 spaces): `npm run format`. Keep code spacious
  and written for people: small named functions, no clever one-liners.
- Prefer proven libraries to hand-written code (argument parsing is commander, MCP is the official SDK,
  schemas are zod).
- Dependencies go one way: `mcp-* → zerro → zenmoney`; `cli-kit` and `mcp-kit` are plumbing. The libraries
  know nothing about MCP, HTTP or the terminal.

## Tests

- Every change keeps 100% coverage and a 100% verified mutation score (`npm run test:coverage`,
  `npm run test:mutation`). Scope a mutation run with `STRYKER_MUTATE=<file>,<file>` while working.
- Ignores (`/* v8 ignore */`, `// Stryker disable`) only for process glue that runs in a subprocess, with
  the reason next to them. An equivalent mutant is better removed by simplifying the code.
- Tests import packages by name (`@tihonove/zerro`), never `../src`: vitest aliases point the names at
  the sources Stryker mutates.
- Live tests (`npm run test:live`) run only against the ZenMoney **test** account and clean up after
  themselves.

## Safety

- No personal data in the repository: no tokens, real accounts, transactions or names. Fixtures are
  synthetic.
- The ZenMoney token is never logged, stored or committed; the servers keep only its SHA-256.

## Commits

English, imperative mood, a short subject line (≤ 72 characters), then a body explaining why when it is
not obvious. One logical change per commit.
