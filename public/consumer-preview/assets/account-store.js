export function orderImagePath(value) {
  if (typeof value === 'string' && /^\/consumer-product-media\/[a-f0-9]{64}$/.test(value)) return value;
  const filename = typeof value === 'string' && value.match(/^\/(?:consumer-preview\/)?assets\/([a-z0-9][a-z0-9._-]*\.(?:webp|png|jpe?g|svg|avif))$/);
  return filename ? '/consumer-preview/assets/' + filename[1] : '';
}
