/** TEMPORARY — visual inspection of /profile/edit. Delete before committing. */
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { setDisplayNameViaApi, signUp } from './fixtures';

const OUT =
  '/private/tmp/claude-501/-Users-sergeya-rzamasov-Programming-ai-claude-video-meetings--claude-worktrees-code-review-pr-54-8e7d9b/8ef59487-1114-41de-9665-5c8a2843218f/scratchpad/shots';

fs.mkdirSync(OUT, { recursive: true });

const probe = () => {
  const input = document.querySelector<HTMLInputElement>('input[name="displayName"]');
  const field = input?.closest('[data-slot="input"], div');
  const describedBy = (input?.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `#${id} missing`);
  const style = input === null || input === undefined ? null : getComputedStyle(input);

  return {
    ariaInvalid: input?.getAttribute('aria-invalid') ?? null,
    dataInvalid: field?.getAttribute('data-invalid') ?? null,
    describedBy,
    borderColor: style?.borderTopColor ?? null,
    matchesUserInvalid: input?.matches(':user-invalid') ?? null,
    outerHtml: input?.parentElement?.outerHTML.slice(0, 300) ?? null,
  };
};

test('inspect the edit page', async ({ browser }) => {
  const user = await signUp(browser);
  await setDisplayNameViaApi(user.token, 'Ada Lovelace');
  const { page } = user;

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/profile/edit');
  await expect(page.getByLabel('Display name')).toHaveValue('Ada Lovelace');

  const pristine = await page.evaluate(probe);

  await page.getByLabel('Display name').fill('   ');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your display name must be')).toBeVisible();
  const invalid = await page.evaluate(probe);

  await page.getByLabel('Display name').fill('Grace Hopper');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your display name is saved.')).toBeVisible();
  await page.waitForTimeout(1200);
  const afterSave = await page.evaluate(probe);
  await page.screenshot({ path: path.join(OUT, '10-light-saved-settled.png'), fullPage: true });

  // Contrast of the feedback colours against what they sit on.
  const contrast = await page.evaluate(() => {
    const luminance = (rgb: string) => {
      const [r = 0, g = 0, b = 0] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const channel = (v: number) => {
        const s = v / 255;

        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };

      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const backdrop = (node: Element | null): string => {
      let at: Element | null = node;
      while (at !== null) {
        const bg = getComputedStyle(at).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        at = at.parentElement;
      }

      return 'rgb(255, 255, 255)';
    };
    const ratio = (node: Element | null) => {
      if (node === null) return null;
      const fg = getComputedStyle(node).color;
      const bg = backdrop(node.parentElement);
      const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];

      return {
        text: node.textContent?.trim().slice(0, 40),
        fg,
        bg,
        size: getComputedStyle(node).fontSize,
        ratio: Number(((a + 0.05) / (b + 0.05)).toFixed(2)),
      };
    };

    const success = [...document.querySelectorAll('output *')].find(
      (n) => n.textContent?.trim() === 'Your display name is saved.',
    );

    return { success: ratio(success ?? null) };
  });

  console.log('PROBE', JSON.stringify({ pristine, invalid, afterSave, contrast }, null, 2));

  await user.context.close();
});
