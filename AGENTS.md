# idea-to-code: agent instructions

**What this is:** a VS Code extension, plus an MCP server, for planning software as nested flowcharts with any coding agent. Plans live in the user's project as YAML (`plan/map.yaml`, `plan/features/<id>.yaml`). History lives outside the project, in a shared app data folder. It must work in VS Code, Cursor and VSCodium.

**Stack:**

- TypeScript 6 (strict, ESM), in a pnpm workspace, tested with Vitest.
- Schema: zod. Plan files: `yaml` (Document API).
- Webview: React + React Flow + ELK.
- Bundling: esbuild for the extension and MCP, Vite for the webview.

## Map

| Path                 | What it is                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`      | The plan format: zod schema (`schema.ts`), loader with source positions (`load.ts`), cross-file validator (`validate.ts`), progress rollup (`progress.ts`), JSON Schema (`jsonSchema.ts`, generated into `schema/`), plan edits (`operations.ts` engine, `opDefinitions.ts` the list), agent tool definitions (`tools.ts`). **Pure, no I/O.** Test fixture: `test/fixtures/toolshed` (fictitious). |
| `packages/store`     | History outside the project folder: `HistoryStore` / `ProjectHistory` (`history.ts`), content-addressed blobs, the event log, the cross-process lock. Chat transcripts live in each editor, not here. `ProjectService` arrives in ITC-8.                                                                                                                                                           |
| `packages/mcp`       | The MCP server; its bin is bundled with `core` and published as `idea-to-code-mcp`.                                                                                                                                                                                                                                                                                                                |
| `packages/webview`   | The chart and app UI (React, Vite). Output is `dist/webview.js` with fixed names.                                                                                                                                                                                                                                                                                                                  |
| `packages/extension` | The VS Code extension. Its `package.json` is the extension manifest; the bundle is `dist/extension.cjs`.                                                                                                                                                                                                                                                                                           |
| `spikes/`            | Throwaway experiments (format, extension runtime and chart prototype). They're reference code for porting, outside the workspace, and get deleted before v1. Don't add to them.                                                                                                                                                                                                                    |
| `docs/`, `.claude/`  | Local-only planning (PRD, architecture, spike results, plans, reports). Gitignored.                                                                                                                                                                                                                                                                                                                |

## Commands (run from the repo root)

```bash
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build   # the full check
pnpm vitest run --project core          # one package's tests
pnpm --filter @idea-to-code/core gen-schema   # after any change to core/src/schema.ts
pnpm validate-plan <dir>                # validate a plan folder (the one containing plan/)
```

## Ground rules

**Code style**

- **Imports:** relative imports use a `.js` suffix (NodeNext), and type-only imports use `import type` (`verbatimModuleSyntax`).
- **Packages:** internal packages export their TypeScript source (`exports: "./src/index.ts"`), with no `dist/`. Only `extension`, `mcp` and `webview` build.
- **Lint:** strict, type-aware typescript-eslint. Fix findings instead of disabling rules. A disable needs a one-line reason in `eslint.config.js`. Stay on TypeScript 6 until typescript-eslint supports 7.

**`core`**

- **No I/O:** callers pass file contents in, and lint rejects `node:*` imports in `core/src`.
- **Problems are data:** a bad plan produces `Issue`s (`file`, `line`, `col`, `severity`, `code`, `message`), never an exception.
- **Issue codes are a stable contract:** agents and the GUIDE quote them. Add new codes; don't rename existing ones.

**The plan format**

- **The zod schema is the source of truth.** Derive types with `z.infer`. After a schema change, run `gen-schema` (a drift test enforces it).
- Format changes are **additive only**, with no version field in user files.
- **IDs:** one namespace across the whole plan; IDs never change on rename.
- `main` is a reserved flow key.
- `status` is allowed only on `step` and `component`. Parent progress is always computed.
- **Block style** (one field per line) is the canonical style the app writes.

**The extension**

- **APIs:** stable VS Code APIs only. `engines.vscode` is `^1.90.0`, with `@types/vscode` pinned to `1.90.0`. Anything newer, like the Language Model API or MCP registration, is detected at runtime, never assumed.
- **Webview security:** a strict CSP, with a nonce and no `eval`. zod runs `jitless` in the webview. ELK runs in a blob-URL worker. Every message between the webview and the extension is parsed with zod, in both directions.
- **UI look:** colours come only from `--vscode-*` variables (light, dark and high contrast). Layout is top-down and at most ~960px wide, growing downward.

**Tests and data**

- **Tests:** each package's tests live in `packages/<pkg>/test/**/*.test.ts`.
- **Fixtures:** use Toolshed or inline plans. **Never commit the founder's real app plan** (`spikes/format/fixtures/career-app`, gitignored), or anything copied or derived from it.

## Where new code goes

| You're adding…                                                          | It goes in…                                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A validation rule                                                       | `core/src/validate.ts`, plus a case in `core/test/validate.test.ts` with its code and exact line                                                                        |
| A format change                                                         | `core/src/schema.ts`, then `gen-schema`, the Toolshed fixture and the GUIDE                                                                                             |
| A plan edit (operation)                                                 | A `defineOperation` entry in `core/src/opDefinitions.ts`, plus cases in `core/test/operations.test.ts`. The agent and MCP tool definitions are generated from the list. |
| History or file access                                                  | `store`                                                                                                                                                                 |
| What the user sees                                                      | `webview`                                                                                                                                                               |
| VS Code integration (views, commands, custom editor, settings, secrets) | `extension`                                                                                                                                                             |

## Working principles

1. **Explain trade-offs:** for any non-obvious choice, give 2–3 options with trade-offs and recommend one. Don't silently pick the popular option.
2. **Ask before guessing:** when a request is ambiguous, ask a few pointed questions with suggested defaults before writing code.
3. **Work directly on `main`:** one commit per Jira ticket (project ITC), with the ticket number in the message (`ITC-7: …`). Commit only when the full check passes, so `main` always works. Plan it, build it, validate it. Work found outside the ticket gets noted, not built.
4. **"Done" means the full check passes.** UI changes get screenshots and a visual review; the founder signs off on the look.
5. **Simple and contained:** keep `core` pure, validate everything that comes in from outside, prefer the simplest thing that works, and say why before adding a dependency.
6. **Git:** commit locally, with no author, `Co-Authored-By` or "generated with" lines. Never push or open PRs unless asked.
7. **Privacy:** never commit private plan data. Check `git status` before every commit.
