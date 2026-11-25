// Exercise the actual navigation on each layout instead of changing the hash directly.
export async function selectWholesaleSection(page, id) {
  const picker = page.locator("#wSection");
  await page.locator('#wSection:visible, #sideNav [data-act="wh-sidebar-toggle"]:visible').first().waitFor();
  if (await picker.isVisible()) {
    await picker.click();
    await page.getByRole("dialog", { name: "Wholesale sections" }).locator(`[data-sheet="${id}"]`).click();
  } else {
    const toggle = page.locator('#sideNav [data-act="wh-sidebar-toggle"]');
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    await page.locator(`#sideNav [data-act="wh-tab"][data-id="${id}"]`).click();
  }
  await page.waitForFunction(section => location.hash === "#wholesale/" + section &&
    document.querySelector('#main[aria-busy="false"] .w-content'), id);
}

export async function revealAdminOptions(page, selector) {
  const details = page.locator(selector);
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
}

export async function selectInvoiceView(page, id) {
  await page.locator('#iwView:visible, nav.iw-tabs:visible').first().waitFor();
  if (await page.locator('#iwView').isVisible()) await page.locator('#iwView').selectOption(id);
  else await page.locator(`nav.iw-tabs [data-id="${id}"]`).click();
}
