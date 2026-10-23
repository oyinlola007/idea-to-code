# idea-to-code: extension runtime spike (ITC-3)

A minimal VS Code extension that tests two things:
- **Hosting:** the webview, the ELK layout worker, the custom editor, optional-API detection and the shared history store work in **VS Code, Cursor and VSCodium**.
- **The chart:** an **interactive, designed chart** of a plan (the career-app plan from `../format`).

It's throwaway spike code, but the chart's nodes, edges, theme tokens, layout rules and navigation seed the real chart renderer (ITC-11) and navigation (ITC-12).

## What's in it

| Path | What |
|---|---|
| `src/host/` | The extension: activity bar view, "Open Plan" tab, custom editor for `plan/**/*.yaml`, file watcher, runtime report |
| `src/shared/` | The view model and the zod-validated message contract between the extension and the webview |
| `src/store/` | Content-addressed blobs + append-only index under a per-project lock (stale-lock recovery) |
| `webview/src/` | React + React Flow chart: measured cards, ELK layout in a worker, rounded edges with label/data chips, navigation reducer, details panel, theme from `--vscode-*` |
| `test/` | Unit tests (vitest) and `test/suite/`, the suite that runs **inside** each editor |
| `scripts/` | Store stress test, the editor test runner, the screenshot tool |

The plan is loaded with the ITC-2 loader (`../format/src`), so run `npm --prefix ../format ci` once.

## Commands

```bash
npm install
npm run typecheck          # host + webview
npm test                   # unit tests (view model, navigation, layout geometry, store, messages)
npm run store:stress       # two Node processes × 500 writes, then stale-lock cases
npm run build              # out/extension.cjs + out/webview/*
npm run test:ext -- --editor vscode --themes   # in-editor suite in VS Code; also captures theme variables
npm run test:ext -- --editor cursor            # … in Cursor (installed app)
npm run test:ext -- --editor vscodium          # … in VSCodium (installed app)
npm run test:ext -- --version 1.90.0 --quick   # … in a downloaded VS Code build (engine floor)
npm run screenshots        # every level × theme → ../../docs/spikes/runtime-screens/
npm run package            # out/idea-to-code-spike.vsix
```

- **Test windows:** `test:ext` opens editor windows; leave them alone until they close.
- **Results:** `out/results/` (with `matrix.md`).
- **Downloads:** VS Code builds are cached in `.vscode-test/` (about 300MB each, gitignored).

## Using it by hand

Install the `.vsix` (`code --install-extension out/idea-to-code-spike.vsix`), then open a folder that contains `plan/map.yaml`, for example `../format/fixtures/career-app`.

**Opening the plan:**
- Click the activity bar icon, then **Open Plan**.
- Or open any `plan/**/*.yaml` file: it opens as a chart. **Show YAML** switches back to text, and **Open Chart to the Side** works from the text editor.

**Moving around:**

| Action | Does |
|---|---|
| Click | Selects a card and opens its details |
| Double-click, Enter or the › chevron | Opens a card's inner flow |
| Esc | Closes the details, then clears the selection, then goes up a level |
| Breadcrumb | Jumps to that level |
| Alt+← / Alt+→ (or the mouse's back/forward buttons) | Back and forward through history |
| Scroll | Pans |
| Pinch, or Cmd+scroll | Zooms |

Saving a plan file updates the chart.

The chart hides React Flow's attribution badge, which its MIT licence allows; credit: [React Flow](https://reactflow.dev).
