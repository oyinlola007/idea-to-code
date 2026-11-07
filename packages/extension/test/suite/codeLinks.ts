// Code links in the real editor, on the Toolshed copy: its deliberately missing link
// is warned about, the warning follows the file coming and going, and a link made
// from the chart is recorded.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension.js';
import { check, planState, step, until } from './helpers.js';

const missingLinkWarnings = () =>
  vscode.languages
    .getDiagnostics()
    .flatMap(([uri, list]) => list.filter((d) => d.source === 'idea-to-code' && d.code === 'code-link-missing').map(() => uri.path));

export async function codeLinkSteps(api: ExtensionApi, root: string): Promise<void> {
  const deposit = join(root, 'src', 'payments', 'deposit.ts');

  await step('a code link to a file that does not exist is warned about, on the card too', async () => {
    await until('the missing-link warning', () => missingLinkWarnings().some((path) => path.endsWith('/plan/features/bookings.yaml')));
    const card = planState(api).model.levels['take-deposit-flow']?.nodes.find((n) => n.id === 'record-deposit');
    check(card?.code?.[0]?.missing === true, `card: ${JSON.stringify(card?.code)}`);
    check(
      planState(api).model.levels.bookings?.nodes.find((n) => n.id === 'pick-dates')?.code?.[0]?.missing !== true,
      'a folder link looks missing',
    );
  });

  await step('the warning clears when the file appears, and comes back when it goes, with no plan edit', async () => {
    const before = (await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0;
    await mkdir(join(root, 'src', 'payments'), { recursive: true });
    await writeFile(deposit, 'export {};\n');
    await until('the warning to clear', () => missingLinkWarnings().length === 0);
    await rm(deposit);
    await until('the warning to come back', () => missingLinkWarnings().length === 1);
    check(
      ((await api.host.service?.projectHistory?.listSnapshots())?.length ?? 0) === before,
      'a file event was recorded as a plan change',
    );
  });

  await step('linking code from the chart is recorded as your change, and shows on the card', async () => {
    const result = await api.host.applyEdit('link_code', { id: 'confirm-booking', paths: ['src/bookings/pick-dates.ts'] });
    check(result.ok, JSON.stringify(result));
    const last = (await api.host.service?.projectHistory?.listSnapshots())?.at(-1);
    check(last?.source === 'ui', `recorded as ${last?.source ?? 'nothing'}`);
    await until('the link on the card', () =>
      (planState(api).model.levels['place-booking-flow']?.nodes.find((n) => n.id === 'confirm-booking')?.code ?? []).some(
        (c) => c.path === 'src/bookings/pick-dates.ts' && c.missing !== true,
      ),
    );
    const refused = await api.host.applyEdit('link_code', { id: 'confirm-booking', paths: ['../outside.ts'] });
    check(!refused.ok, 'a link outside the project was accepted');
  });
}
