// Follow the same public controls on mobile and desktop.
export async function openWholesaleAccountMenu(page) {
  const basket = page.locator('#basket-dialog[open]');
  if (await basket.count()) await basket.locator('[data-close]').click();
  const trigger = page.locator('#account-toggle');
  if (await trigger.isVisible() && !await page.locator('#wholesale-account').evaluate(node => node.matches(':popover-open'))) {
    await trigger.click();
    await page.locator('#wholesale-account:popover-open').waitFor();
  }
}

export async function openWholesaleAccount(page) {
  await openWholesaleAccountMenu(page);
  await page.locator('#my-account').click();
}

export async function openWholesaleOrders(page) {
  await openWholesaleAccountMenu(page);
  await page.locator('#my-orders').click();
  await page.locator('#orders-dialog[open]').waitFor();
}

export async function openWholesaleBasket(page) {
  if (!await page.locator('#basket-dialog[open]').count()) {
    await page.locator('.site-header [data-basket]').click();
    await page.locator('#basket-dialog[open]').waitFor();
  }
}

export async function chooseWholesalePack(page, card, value) {
  await card.locator('[data-pack-open]').click();
  await page.locator(`#coffee-choice-menu [data-choice="${value}"]`).click();
}

export async function chooseWholesaleGrind(page, card, value) {
  await card.locator('[data-grind-open]').click();
  await page.locator(`#coffee-choice-menu [data-choice="${value}"]`).click();
}

export async function fillWholesaleSearch(page, value) {
  if (!await page.locator('#coffee-search').isVisible()) await page.locator('#search-toggle').click();
  await page.locator('#coffee-search').fill(value);
}
