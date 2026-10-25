import { expect, test, type Page } from '@playwright/test';

// The page background each theme must paint (src/styles/theme.css --bg-page).
const PAGE_BACKGROUND = { light: 'rgb(245, 247, 246)', dark: 'rgb(10, 17, 15)' } as const;
const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent']);

async function openKitchenSink(page: Page, theme: 'light' | 'dark') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.context().addCookies([{ name: 'theme', value: theme, url: test.info().project.use.baseURL! }]);
  await page.goto('/kitchen-sink');
  return errors;
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`kitchen sink, ${theme} theme`, () => {
    test('paints the theme and every card surface', async ({ page }) => {
      const errors = await openKitchenSink(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(PAGE_BACKGROUND[theme]);

      // A token or host recipe that failed to load renders as a transparent
      // box with no border, on a green build. Check every section card.
      const surfaces = page.locator('main [data-surface]');
      await expect(surfaces).toHaveCount(6);
      for (const surface of await surfaces.all()) {
        const style = await surface.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, border: s.borderTopWidth, id: el.getAttribute('data-surface') };
        });
        expect(TRANSPARENT.has(style.bg), `${style.id} background`).toBe(false);
        expect(style.border, `${style.id} border`).not.toBe('0px');
      }
      expect(errors).toEqual([]);
    });

    test('gives buttons their material and inputs their focus ring', async ({ page }) => {
      await openKitchenSink(page, theme);
      const primary = await page.getByTestId('button-primary').evaluate((el) => {
        const s = getComputedStyle(el);
        return { image: s.backgroundImage, shadow: s.boxShadow };
      });
      expect(primary.image).toContain('linear-gradient');
      // --btn-still-lift is a box-shadow value; a colour there would read 'none'.
      expect(primary.shadow).not.toBe('none');

      const destructive = await page.getByTestId('button-destructive').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(TRANSPARENT.has(destructive)).toBe(false);

      const input = page.getByTestId('input-client');
      await input.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      expect(await input.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
    });

    test('opens a modal on a painted surface', async ({ page }) => {
      await openKitchenSink(page, theme);
      await page.getByTestId('open-modal').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // The dialog itself carries the .surface-popup-texture host recipe.
      expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('radial-gradient');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}

test('switches theme and language, and remembers both', async ({ page }) => {
  await page.goto('/kitchen-sink');
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('locale-bg').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('UI компоненти');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'bg');
});

test('home page links to the kit', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'See the UI kit' }).click();
  await expect(page).toHaveURL(/\/kitchen-sink$/);
});
