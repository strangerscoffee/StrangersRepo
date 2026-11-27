const attemptKey = 'strangers-coffee-retail.order-attempt.v2';
const maxAttemptAge = 2 * 60 * 60 * 1000;

export const orderReferencePattern = /^SC-[A-F0-9]{8}$/;
export const orderTokenPattern = /^[A-Za-z0-9_-]{32,128}$/;

function readAttempt() {
  try {
    const value = JSON.parse(sessionStorage.getItem(attemptKey) ?? 'null');
    if (value && Number.isFinite(value.createdAt) && Date.now() - value.createdAt < maxAttemptAge
        && /^[a-f0-9-]{36}$/.test(value.key) && value.payload?.contact
        && Array.isArray(value.payload?.lines) && value.payload.lines.length) return value;
    sessionStorage.removeItem(attemptKey);
  } catch {
    // The current page can retry without session storage.
  }
  return null;
}

let attempt = readAttempt();

export function pendingOrderAttempt() {
  return attempt;
}

export function prepareOrderAttempt(payload, identity) {
  if (attempt) return attempt;
  attempt = {
    createdAt: Date.now(),
    key: crypto.randomUUID(),
    identity,
    payload,
  };
  try { sessionStorage.setItem(attemptKey, JSON.stringify(attempt)); } catch {}
  return attempt;
}

export function clearOrderAttempt() {
  attempt = null;
  try { sessionStorage.removeItem(attemptKey); } catch {}
}

async function orderRequest(path, body, expectedSession) {
  const response = await fetch('/api/retail/orders' + path, {
    method: 'POST',
    credentials: expectedSession === 'guest' ? 'omit' : 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      ...(expectedSession ? { 'X-Retail-Profile-Session': expectedSession } : {}),
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw Object.assign(new Error(typeof result?.message === 'string' ? result.message : 'We couldn’t open this order. Try again.'), {
      status: response.status,
      code: result?.error,
    });
  }
  if (!result?.order || !orderReferencePattern.test(result.order.reference) || !Array.isArray(result.order.lines)
      || !Number.isSafeInteger(result.order.pricing?.total)) {
    throw new Error('We couldn’t confirm this order yet. Try again.');
  }
  return result;
}

export function placeRetailOrder(currentAttempt, expectedSession) {
  return orderRequest('', { ...currentAttempt.payload, idempotencyKey: currentAttempt.key }, expectedSession);
}

export function loadRetailOrder(reference, token, expectedSession) {
  return orderRequest('/' + encodeURIComponent(reference), token ? { token } : {}, token ? 'guest' : expectedSession);
}

export function trackingPath(reference, token) {
  const hash = token && orderTokenPattern.test(token) ? '#' + token : '';
  return '/checkout/?' + new URLSearchParams({ order: reference }) + hash;
}
