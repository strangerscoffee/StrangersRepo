import { orderImagePath } from './account-store.js';

export function storefrontProducts(rows) {
  return rows.map(product => ({
    ...product,
    category: product.category === 'coffee' ? undefined : product.category,
    image: orderImagePath(product.image) || '/consumer-preview/assets/mark.svg',
  }));
}

// The live catalogue replaces the entire range in one pass. A removed item must
// disappear even if the browser has its original product bundled or saved.
export function createAvailability(products) {
  let pending;
  let known = false;
  let revision = 0;

  function setProducts(rows) {
    const next = storefrontProducts(rows);
    products.splice(0, products.length, ...next);
    revision++;
    known = true;
    globalThis.document?.dispatchEvent(new Event('retail-catalogue-updated'));
  }

  function refresh(force = false) {
    if (pending) return pending;
    if (known && !force) return Promise.resolve(true);
    known = false;
    pending = Promise.resolve().then(async () => {
      try {
        const seed = globalThis.document?.getElementById('retail-catalogue');
        let data;
        if (seed && !force) {
          seed.remove();
          data = JSON.parse(seed.textContent);
        } else {
          const response = await fetch('/api/retail/products', {
            headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'omit',
            redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) return false;
          data = await response.json();
        }
        if (!Array.isArray(data?.products)) return false;
        setProducts(data.products);
        return true;
      } catch {
        return false;
      } finally {
        pending = null;
      }
    });
    return pending;
  }

  return { refresh, setProducts, get known() { return known; }, get revision() { return revision; } };
}
