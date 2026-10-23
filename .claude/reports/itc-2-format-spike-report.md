# Implementation Report: ITC-2 plan file format spike

**Plan**: `.claude/plans/itc-2-format-spike.md`   **Branch**: `feature/itc-2-format-spike`   **Status**: COMPLETE (the small-tier model test was deferred by the founder to ITC-15/16; the career-app content review moves to the ITC-3 prototype)

## Summary
Built a standalone TypeScript spike in `spikes/format/` that tests the plan format end to end:
- a zod v0 schema and a validator that checks rules across files;
- comment-preserving, validated operations;
- a hand-written career-app plan;
- an agent context view (outline, flow, map view);
- an ELK layout renderer;
- two agent harnesses.

The Claude Code route reached **9/9 (100%)** after the run-1 failures (7/9) led to two style and strictness fixes. The built-in route is proven with a mock model; real-model runs are waiting on keys. Results and the provisional decision are in `docs/spikes/format.md`.

## Tasks completed
- Task 0: `git init` (branch `feature/itc-2-format-spike`, no commits).
- Task 1: `spikes/format/package.json`, `tsconfig.json`, `vitest.config.ts`, and the root `.gitignore` updated (CREATE/UPDATE).
- Task 2: `src/schema.ts` (CREATE).
- Task 3: `src/load.ts`, `src/validate.ts`, `src/cli/validate.ts` (CREATE).
- Task 4: `test/validate.test.ts` (CREATE).
- Task 5: `fixtures/career-app/plan/{map.yaml, features/job-search.yaml, features/email-integration.yaml}` (CREATE).
- Task 6: `src/ids.ts`, `src/ops.ts` (CREATE).
- Task 7: `test/ops.test.ts` (CREATE).
- Task 8: `src/outline.ts`, `test/outline.test.ts` (CREATE).
- Task 9: `layout/render.ts` → `out/layout/index.html` plus `out/layout/svg/*.svg` (CREATE).
- Task 10: `guide/GUIDE.md`, `guide/SKILL.md` (CREATE).
- Task 11: `fixtures/conversations/*.md`, `harness/assertions.ts`, `test/assertions.test.ts` (CREATE).
- Task 12: `harness/claude.ts` (CREATE); run twice (18 runs).
- Task 13: `harness/builtin.ts`, `.env.example` (CREATE); mock run passes.
- Task 14: keys checkpoint done (OpenAI only). `gpt-5.5`: 8/8 completed runs valid and passed; 2 runs plus all `gpt-5.4-mini` runs hit the account's credit limit. The small-tier test is deferred.
- Task 15: `docs/spikes/format.md` (results and provisional decision) and `spikes/format/README.md` (CREATE).

## Tests added
40 Vitest tests across 4 files, all passing:
- **Validator:** 15 rule codes with exact lines; warnings; partial loading; rollup; start/end without a label; the comma hint.
- **Operations:** IDs, style, rejections leave the workspace unchanged, expand, rename keeps the ID, remove cascades, features and connections, comment preservation.
- **Outline:** 2 snapshots.
- **Assertions.**

## Validation results
- `npm run typecheck`: pass (TypeScript 7.0.2).
- `npm test`: 40/40.
- `npm run validate -- fixtures/career-app`: 0 errors, 4 expected warnings.
- `npm run layout`: 16 panes, 0 edges through nodes.
- `npm run harness:builtin -- --mock`: PASS (1 rejected call, counted as a retry).
- `npm run harness:claude`: run 1 7/9, run 2 **9/9**.
- `npm run harness:builtin`: `gpt-5.5` 8/8 completed runs (100%); the remaining runs failed on API credit.

## Deviations from the plan
- **Broken cases are inline in `test/validate.test.ts`** instead of `fixtures/broken/<case>/` folders, so each case sits next to its expected code and line.
- **Default Anthropic models are `claude-opus-5-5` + `claude-haiku-5-5`** (from the claude-api reference: the current default model plus the small tier) instead of Sonnet. Sonnet can be added via `MODELS`.
- **Format rules added during the spike** (all recorded in the results doc): `main` reserved; `ref` may target components and features without files; optional `label` on start/end; the status-on-parent warning; first node creates a listed feature's file.
- **Canonical style switched from inline `{ }` to block style** after Claude Code run 1. The fixtures were converted with the `yaml` library, keeping comments.
- **The renderer places edge labels at the middle of the longest segment**, because ELK's label positions drifted off their edges.
- **The Claude harness uses `--output-format stream-json --verbose`**, to detect whether the skill was discovered and GUIDE.md read.
- **`harness:builtin` uses `--env-file-if-exists`**, so `--mock` works without a `.env`.

## Issues encountered
- `npm` skipped esbuild's install script; tsx still works through the platform package.
- elkjs default import doesn't typecheck under NodeNext (CommonJS); it's loaded via `createRequire`.
- The `yaml` library keeps comments, but re-serializes formatting. Default line wrapping bloated diffs, so `lineWidth: 0` is used (see the results doc).
- Claude Code run 1 failures: an unquoted comma inside inline `{ }`; start/end without labels. Both fixed, and run 2 was 9/9.
- The OpenAI account ran out of credit mid-run. The harness now reports API failures separately and stops once credit is gone.
- The founder's layout review led to a 960px-wrapping experiment; the decision is top-down within 960px, and visual design moves to ITC-3/ITC-11 (Jira updated).
