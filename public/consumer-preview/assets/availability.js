export function createAvailability(products) {
  const initiallyUnavailable = new Set(products.filter(product => product.available === false).map(product => product.id));
  let pending;
  let known = false;

  function refresh() {
    if (known) return Promise.resolve(true);
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetch('/consumer-auth/availability', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(1250),
        });
        if (!response.ok) return false;
        const data = await response.json();
        if (!Array.isArray(data?.unavailable) || !data.unavailable.every(id => typeof id === 'string')) return false;
        const unavailable = new Set([...initiallyUnavailable, ...data.unavailable]);
        for (const product of products) {
          product.available = !unavailable.has(product.id) && !product.contents?.some(id => unavailable.has(id));
        }
        known = true;
        return true;
      } catch {
        return false;
      } finally {
        pending = null;
      }
    });
    return pending;
  }

  return { refresh, get known() { return known; } };
}
