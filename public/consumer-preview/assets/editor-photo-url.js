// Published and draft documents have both passed the structured editor schema.
// Keep resolution here small so shopper pages do not import the admin asset inventory.
export function photo(value, preview = false) {
  if (typeof value !== 'string') return '';
  const asset = /^asset:([a-z0-9][a-z0-9_.-]{0,110}\.(?:webp|png|jpe?g|svg))$/i.exec(value);
  if (asset) return (preview ? '/api/admin/consumer/editor/assets/' : '/consumer-preview/assets/') + asset[1];
  const media = /^media:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(value);
  return media ? (preview ? '/api/admin/consumer/editor/media/' : '/consumer-media/') + media[1] : '';
}
