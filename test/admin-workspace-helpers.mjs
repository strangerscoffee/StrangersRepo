// Exercise the actual navigation on each layout instead of changing the hash directly.
export async function selectWholesaleSection(page, id) {
  const navigation = page.locator('#wSection, #sideNav [data-act="wh-tab"]').first();
  await navigation.waitFor({ state: "attached" });
  if (await page.locator("#wSection").isVisible()) await page.locator("#wSection").selectOption(id);
  else await page.locator(`#sideNav [data-act="wh-tab"][data-id="${id}"]`).click();
  await page.waitForFunction(section => location.hash === "#wholesale/" + section &&
    document.querySelector('#main[aria-busy="false"] .w-content'), id);
}

export async function revealAdminOptions(page, selector) {
  const details = page.locator(selector);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}
