import { expect, test, type Browser, type Page } from '@playwright/test';

// All contexts use one fixed time zone so the datetime-local value we type is deterministic.
const TIMEZONE = 'UTC';

interface Player {
  page: Page;
  email: string;
  name: string;
}

async function newPlayer(browser: Browser, baseURL: string, label: string, stamp: number): Promise<Player> {
  const context = await browser.newContext({ baseURL, timezoneId: TIMEZONE });
  const page = await context.newPage();
  return {
    page,
    email: `${label.toLowerCase()}+${stamp}@test.local`,
    name: `${label} ${stamp}`,
  };
}

async function register({ page, email, name }: Player): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel('Display name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
}

/** `YYYY-MM-DDTHH:MM` in UTC (the contexts' time zone), as a datetime-local input expects. */
function datetimeLocal(date: Date): string {
  return date.toISOString().slice(0, 16);
}

test('friends, scheduling, invites, RSVP, calendar and access control', async ({ browser, baseURL }) => {
  if (!baseURL) throw new Error('baseURL must be set in playwright.config.ts');
  const stamp = Date.now();
  const ana = await newPlayer(browser, baseURL, 'Ana', stamp);
  const ben = await newPlayer(browser, baseURL, 'Ben', stamp);
  const cleo = await newPlayer(browser, baseURL, 'Cleo', stamp);

  // 1. Everyone registers through the UI.
  await register(ana);
  await register(ben);
  await register(cleo);

  // 2. Ana sends Ben a friend request; Ben accepts; Ana sees Ben as a friend.
  await ana.page.getByRole('link', { name: 'Friends' }).click();
  await expect(ana.page).toHaveURL(/\/friends$/);
  await ana.page.getByLabel("Friend's email").fill(ben.email);
  await ana.page.getByRole('button', { name: 'Send request' }).click();

  await ben.page.goto('/friends');
  await ben.page.getByRole('button', { name: 'Accept' }).click();
  await expect(ben.page.getByRole('link', { name: ana.name })).toBeVisible();

  await ana.page.reload();
  await expect(ana.page.getByRole('link', { name: ben.name })).toBeVisible();
  await expect(ana.page.getByRole('button', { name: 'Remove' })).toBeVisible();

  // 3. Ana schedules a cash game a minute ahead and invites Ben.
  const gameName = `Friday cash ${stamp}`;
  await ana.page.getByRole('link', { name: 'Lobby' }).click();
  await expect(ana.page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  await ana.page.getByRole('button', { name: 'New game' }).click();
  await ana.page.getByLabel('Game name').fill(gameName);
  await ana.page.getByLabel('Starts at').fill(datetimeLocal(new Date(Date.now() + 60_000)));
  await ana.page.getByRole('button', { name: 'Schedule game' }).click();

  await expect(ana.page).toHaveURL(/\/games\/[0-9a-f-]{36}$/);
  await expect(ana.page.getByRole('heading', { name: gameName })).toBeVisible();
  const gameId = new URL(ana.page.url()).pathname.split('/').pop();
  if (!gameId) throw new Error(`no game id in ${ana.page.url()}`);

  await ana.page.getByRole('checkbox', { name: ben.name }).check();
  const invited = ana.page.waitForResponse(
    (r) => r.url().endsWith(`/api/games/${gameId}/invites`) && r.request().method() === 'POST',
  );
  await ana.page.getByRole('button', { name: 'Send invites' }).click();
  expect((await invited).status()).toBe(200);

  // 4. Ben gets a notification, follows it, RSVPs yes and downloads the calendar file.
  await ben.page.goto('/');
  await ben.page.getByRole('button', { name: 'Notifications' }).click();
  const notification = ben.page.getByText(`invited you to ${gameName}`);
  await expect(notification).toBeVisible();
  await notification.click();
  await expect(ben.page).toHaveURL(new RegExp(`/games/${gameId}$`));
  await expect(ben.page.getByRole('heading', { name: gameName })).toBeVisible();

  const yes = ben.page.getByRole('button', { name: 'Yes', exact: true });
  await yes.click();
  await expect(yes).toHaveAttribute('aria-pressed', 'true');

  const calendar = ben.page.getByRole('link', { name: 'Add to calendar' });
  await expect(calendar).toHaveAttribute('href', `/api/games/${gameId}/calendar.ics`);
  const href = await calendar.getAttribute('href');
  if (!href) throw new Error('Add to calendar link has no href');
  const ics = await ben.page.request.get(href);
  expect(ics.status()).toBe(200);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('BEGIN:VEVENT');

  // 5. Cleo is not a member: the API answers 403 and the page says so (F6).
  const forbidden = await cleo.page.request.get(`/api/games/${gameId}`);
  expect(forbidden.status()).toBe(403);
  await cleo.page.goto(`/games/${gameId}`);
  await expect(cleo.page.getByText("You don't have access to this game")).toBeVisible();

  await Promise.all([ana, ben, cleo].map((p) => p.page.context().close()));
});
