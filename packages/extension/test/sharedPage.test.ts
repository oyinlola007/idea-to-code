// The exported web page: one self-contained file, with the plan as data that can't
// break out of its block, and scripts allowed only by their exact hashes.
import { sharedState } from '@idea-to-code/core';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pageFileName } from '../src/exportPageName.js';
import { sharedPageHtml } from '../src/sharedPage.js';

const texts = {
  'plan/map.yaml': 'project: Garden </script><script>alert(1)</script>\nfeatures:\n  - id: plots\n    label: Plots & beds\n',
};
const state = sharedState(texts, 'garden');
const page = () =>
  sharedPageHtml({
    title: 'Garden <share>',
    state,
    script: 'console.log("app");',
    style: '@font-face{src:url(./codicon.ttf?abc)format("truetype")}.card{color:red}',
    font: new Uint8Array([1, 2, 3]),
  });

describe('the shared web page', () => {
  it('holds everything inside: styles, icon font, theme, plan and app, with no outside requests', () => {
    const html = page();
    expect(html).toContain('url(data:font/ttf;base64,AQID)');
    expect(html).not.toContain('codicon.ttf');
    expect(html).toContain('--vscode-editor-background');
    expect(html).toContain('<script type="module">console.log("app");</script>');
    expect(html).not.toMatch(/(src|href)="https?:/);
  });

  it('keeps plan text as data: a closing tag in it can’t end the block or add markup', () => {
    const html = page();
    const data = html.slice(html.indexOf('<script type="application/json" id="plan">'), html.indexOf('</script>'));
    expect(data).not.toContain('<script>alert');
    expect(JSON.parse(data.slice(data.indexOf('>') + 1))).toEqual(JSON.parse(JSON.stringify(state)));
    expect(html).toContain('<title>Garden &lt;share&gt;</title>');
  });

  it('allows exactly its own two scripts, by hash, and nothing from elsewhere', () => {
    const html = page();
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    const scripts = [...html.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    expect(scripts).toHaveLength(2);
    for (const code of scripts) expect(csp).toContain(`'sha256-${createHash('sha256').update(code).digest('base64')}'`);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('follows the reader’s system theme until they switch, and the switch wins over it', () => {
    const html = page();
    expect(html).toContain(":root[data-theme='dark']");
    expect(html).toContain(":root:not([data-theme='light'])");
    expect(html).toContain("message.type === 'toggle-theme'");
    expect(html).toContain('localStorage');
  });

  it('names the file after the project', () => {
    expect(pageFileName('Tool Shed!')).toBe('tool-shed-plan.html');
    expect(pageFileName('***')).toBe('plan-plan.html');
  });
});
