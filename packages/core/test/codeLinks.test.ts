// Links from the plan to code: which paths are allowed, where each link is written,
// and the warnings for links the host found missing.
import { describe, expect, it } from 'vitest';
import { checkCodeLinkPath, codeLinkPaths, codeLinksOf, missingCodeLinkIssues, normalizeCodeLink } from '../src/codeLinks.js';
import { loadFromTexts } from '../src/load.js';
import { validateProject } from '../src/validate.js';

const MAP = `project: Test
features:
  - id: shop
    label: Shop
components:
  - id: db
    label: Database
    kind: database
    implements:
      - db/schema.sql
`;

const shop = (links: string) => `feature: shop
flows:
  main:
    label: Shop
    nodes:
      - id: browse
        type: step
        label: Browse
        implements:
${links}
      - id: in-stock
        type: decision
        label: In stock?
`;

const plan = (links: string) => loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': shop(links) });

describe('code link paths', () => {
  it('allows files and folders inside the project', () => {
    for (const path of ['src/a.ts', 'src/', 'README.md', 'a/b/c.test.ts', 'src/.config/x.json'])
      expect(checkCodeLinkPath(path), path).toBeNull();
  });

  it('refuses anything that could leave the project, with a reason', () => {
    expect(checkCodeLinkPath('/etc/passwd')).toContain('relative');
    expect(checkCodeLinkPath('C:/x')).toContain('relative');
    expect(checkCodeLinkPath('../x')).toContain('inside');
    expect(checkCodeLinkPath('src/./x')).toContain('inside');
    expect(checkCodeLinkPath('a//b')).toContain('inside');
    expect(checkCodeLinkPath('src\\x')).toContain('/');
    expect(checkCodeLinkPath(' ')).toContain('empty');
    expect(checkCodeLinkPath('a'.repeat(301))).toContain('300');
  });

  it('treats a folder with and without its trailing slash as the same link', () => {
    expect(normalizeCodeLink('src/')).toBe('src');
    expect(normalizeCodeLink('src/a.ts')).toBe('src/a.ts');
  });
});

describe('listing links', () => {
  it('lists shared components and flow nodes with the line each link is on', () => {
    const links = codeLinksOf(plan('          - src/browse.ts\n          - src/'));
    expect(links.map((l) => [l.nodeId, l.path, l.file, l.line])).toEqual([
      ['db', 'db/schema.sql', 'plan/map.yaml', 10],
      ['browse', 'src/browse.ts', 'plan/features/shop.yaml', 10],
      ['browse', 'src/', 'plan/features/shop.yaml', 11],
    ]);
  });

  it('gives hosts only the distinct, allowed paths to look for', () => {
    expect(codeLinkPaths(plan('          - src/\n          - src\n          - ../escape.ts'))).toEqual(['db/schema.sql', 'src']);
  });

  it('turns the paths a host found missing into warnings at each link', () => {
    const issues = missingCodeLinkIssues(plan('          - src/browse.ts\n          - src/'), new Set(['src']));
    expect(issues).toEqual([
      {
        file: 'plan/features/shop.yaml',
        line: 11,
        col: 13,
        severity: 'warning',
        code: 'code-link-missing',
        message: '"Browse" links to src/, which doesn\'t exist. Update the link or remove it',
      },
    ]);
  });
});

describe('validating links', () => {
  it('flags a link that leaves the project as an error at its line, and the file still loads', () => {
    const project = plan('          - src/ok.ts\n          - ../../etc/passwd');
    const issue = validateProject(project).find((i) => i.code === 'code-link-invalid');
    expect(issue).toMatchObject({ file: 'plan/features/shop.yaml', line: 11, severity: 'error' });
    expect(issue?.message).toContain('stay inside the project');
    expect(project.features[0]?.data).not.toBeNull();
  });

  it('allows the same file listed twice, without a warning', () => {
    expect(validateProject(plan('          - src/\n          - src')).filter((i) => i.code.startsWith('code-link'))).toEqual([]);
  });

  it('warns about links on a node with a child flow, pointing at the steps inside', () => {
    const text = `feature: shop
flows:
  main:
    label: Shop
    nodes:
      - id: checkout
        type: step
        label: Checkout
        expands: checkout-flow
        implements:
          - src/checkout
  checkout-flow:
    label: Checkout
    nodes:
      - id: pay
        type: step
        label: Pay
`;
    const issue = validateProject(loadFromTexts({ 'plan/map.yaml': MAP, 'plan/features/shop.yaml': text })).find(
      (i) => i.code === 'code-link-on-parent',
    );
    expect(issue).toMatchObject({ file: 'plan/features/shop.yaml', line: 10, severity: 'warning' });
    expect(issue?.message).toContain('steps inside');
  });

  it('reads an empty list written by hand as no links, and keeps the file readable', () => {
    const project = loadFromTexts({
      'plan/map.yaml': MAP,
      'plan/features/shop.yaml': shop('').replace('implements:\n\n', 'implements: []\n'),
    });
    expect(project.features[0]?.data).not.toBeNull();
    expect(validateProject(project).filter((i) => i.severity === 'error')).toEqual([]);
    expect(codeLinksOf(project).map((l) => l.nodeId)).toEqual(['db']);
  });
});
