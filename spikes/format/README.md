# ITC-2 spike: plan file format

Proves the plan file format before product code depends on it. Spike-quality code; the **fixtures, schema decisions and results** feed ITC-4. Results and the decision live in `docs/spikes/format.md` (local).

> The career-app plan in `fixtures/career-app/` is a **draft written for the spike**. It still needs the founder's review.

## Layout

| Path | What |
|---|---|
| `src/schema.ts` | zod v0 schema for `plan/map.yaml` and `plan/features/*.yaml` |
| `src/load.ts`, `src/validate.ts` | loading with line numbers; rules that span files; progress rollup |
| `src/ops.ts` | comment-preserving operations; each is validated and rejected if it breaks the plan |
| `src/outline.ts` | the text views an agent gets as context (outline, flow, per-turn map view) |
| `fixtures/career-app/` | hand-written plan: overview, *Job search* (3 levels), *Email integration* (system design) |
| `fixtures/conversations/` | two planning conversations used by the built-in agent harness |
| `guide/` | draft `GUIDE.md` and Claude Code `SKILL.md` |
| `harness/` | the two agent routes and their task checks |
| `layout/render.ts` | ELK layout of every level, both directions, as HTML and SVG |

## Commands

```bash
npm install
npm run typecheck
npm test
npm run validate -- fixtures/career-app
npm run layout                      # then open out/layout/index.html
npm run harness:claude              # headless Claude Code, 3 tasks × 3 runs (uses your Claude Code login)
npm run harness:builtin -- --mock   # built-in agent loop with a scripted model (no keys)
npm run harness:builtin             # real models; needs .env (copy .env.example)
```

Results are written to `out/results/` (gitignored).
