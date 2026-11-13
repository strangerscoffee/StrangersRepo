// Follow the public account action through the compact mobile header or desktop inline controls.
export async function openWholesaleAccountMenu(page) {
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
