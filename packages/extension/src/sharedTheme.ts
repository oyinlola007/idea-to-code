// The colours a shared web page uses in place of the editor's theme: VS Code's
// default Light Modern and Dark Modern values, read from a real window, so the page
// looks like the extension. It follows the reader's light or dark setting until they
// pick one with the page's switch, which sets data-theme on the root.
const LIGHT = `
  --vscode-badge-background: #cccccc;
  --vscode-button-background: #005fb8;
  --vscode-button-border: rgba(0, 0, 0, 0.1);
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #0258a8;
  --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b;
  --vscode-button-secondaryHoverBackground: #cccccc;
  --vscode-charts-green: #388a34;
  --vscode-charts-yellow: #bf8803;
  --vscode-descriptionForeground: #3b3b3b;
  --vscode-dropdown-background: #ffffff;
  --vscode-dropdown-border: #cecece;
  --vscode-dropdown-foreground: #3b3b3b;
  --vscode-editor-background: #ffffff;
  --vscode-editor-font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-editor-foreground: #3b3b3b;
  --vscode-editorLineNumber-foreground: #6e7681;
  --vscode-editorWarning-foreground: #bf8803;
  --vscode-editorWidget-background: #f8f8f8;
  --vscode-editorWidget-border: rgba(59, 59, 59, 0.2);
  --vscode-errorForeground: #f85149;
  --vscode-focusBorder: #005fb8;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif;
  --vscode-font-size: 13px;
  --vscode-font-weight: normal;
  --vscode-foreground: #3b3b3b;
  --vscode-icon-foreground: #3b3b3b;
  --vscode-input-background: #ffffff;
  --vscode-input-border: #cecece;
  --vscode-input-foreground: #3b3b3b;
  --vscode-input-placeholderForeground: #767676;
  --vscode-inputValidation-warningBackground: #f6f5d2;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-menu-background: #ffffff;
  --vscode-menu-border: #cecece;
  --vscode-menu-foreground: #3b3b3b;
  --vscode-menu-selectionBackground: #005fb8;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-panel-border: #e5e5e5;
  --vscode-panelTitle-activeBorder: #005fb8;
  --vscode-panelTitle-activeForeground: #3b3b3b;
  --vscode-panelTitle-inactiveForeground: #3b3b3b;
  --vscode-sideBar-background: #f8f8f8;
  --vscode-sideBar-foreground: #3b3b3b;
  --vscode-textLink-foreground: #005fb8;
  --vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31);
  --vscode-widget-border: #e5e5e5;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.16);
`;

const DARK = `
  --vscode-badge-background: #616161;
  --vscode-button-background: #0078d4;
  --vscode-button-border: rgba(255, 255, 255, 0.1);
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: rgba(0, 0, 0, 0);
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #2b2b2b;
  --vscode-charts-green: #89d185;
  --vscode-charts-yellow: #cca700;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-dropdown-foreground: #cccccc;
  --vscode-editor-background: #1f1f1f;
  --vscode-editor-font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-editor-foreground: #cccccc;
  --vscode-editorLineNumber-foreground: #6e7681;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: rgba(204, 204, 204, 0.2);
  --vscode-errorForeground: #f85149;
  --vscode-focusBorder: #0078d4;
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif;
  --vscode-font-size: 13px;
  --vscode-font-weight: normal;
  --vscode-foreground: #cccccc;
  --vscode-icon-foreground: #cccccc;
  --vscode-input-background: #313131;
  --vscode-input-border: #3c3c3c;
  --vscode-input-foreground: #cccccc;
  --vscode-input-placeholderForeground: #989898;
  --vscode-inputValidation-warningBackground: #352a05;
  --vscode-inputValidation-warningBorder: #b89500;
  --vscode-menu-background: #1f1f1f;
  --vscode-menu-border: #454545;
  --vscode-menu-foreground: #cccccc;
  --vscode-menu-selectionBackground: #0078d4;
  --vscode-menu-selectionForeground: #ffffff;
  --vscode-panel-border: #2b2b2b;
  --vscode-panelTitle-activeBorder: #0078d4;
  --vscode-panelTitle-activeForeground: #cccccc;
  --vscode-panelTitle-inactiveForeground: #9d9d9d;
  --vscode-sideBar-background: #181818;
  --vscode-sideBar-foreground: #cccccc;
  --vscode-textLink-foreground: #4daafc;
  --vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.31);
  --vscode-widget-border: #313131;
  --vscode-widget-shadow: rgba(0, 0, 0, 0.36);
`;

export const SHARED_THEME_CSS = `:root {${LIGHT}}
:root[data-theme='dark'] {${DARK}}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {${DARK}}
}`;
