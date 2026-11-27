export const productRoutes = Object.freeze({
  "christmas-blend": {
    "id": "christmas-blend",
    "name": "Christmas Blend"
  },
  "boozy-santa-blend": {
    "id": "boozy-santa-blend",
    "name": "Boozy Santa Blend"
  },
  "ethiopia-cherry-bomb": {
    "id": "cherry-bomb",
    "name": "Ethiopia Cherry Bomb"
  },
  "brazil-fazenda-bom-jesus-natural": {
    "id": "bom-jesus",
    "name": "Brazil Fazenda Bom Jesus Natural"
  },
  "colombia-anserma-natural": {
    "id": "anserma",
    "name": "Colombia Anserma Natural"
  },
  "ethiopia-idido-anaerobic-natural": {
    "id": "ethiopia-idido-anaerobic-natural",
    "name": "Ethiopia Idido Anaerobic Natural"
  },
  "honduras-rosalina-ramos-natural": {
    "id": "honduras-rosalina-ramos-natural",
    "name": "Honduras Rosalina Ramos Natural"
  },
  "ethiopia-rocko-mountain-natural": {
    "id": "rocko",
    "name": "Ethiopia Rocko Mountain Natural"
  },
  "colombia-campo-santo-washed": {
    "id": "colombia-campo-santo-washed",
    "name": "Colombia Campo Santo Washed"
  },
  "decaf-colombia-san-lorenzo": {
    "id": "decaf",
    "name": "Decaf Colombia San Lorenzo"
  },
  "half-caff-blend": {
    "id": "half-caff-blend",
    "name": "Half Caff Blend"
  },
  "house-blend": {
    "id": "house-blend",
    "name": "House Blend"
  },
  "fine-city-blend": {
    "id": "fine-city-blend",
    "name": "Fine City Blend"
  },
  "roasters-blend": {
    "id": "roasters-blend",
    "name": "Roasters Blend"
  },
  "twin-peaks-blend": {
    "id": "twin-peaks-blend",
    "name": "Twin Peaks Blend"
  },
  "roasters-tasting-flight": {
    "id": "roasters-tasting-flight",
    "name": "Roaster’s Tasting Flight"
  },
  "strangers-coffee-tea-towel": {
    "id": "strangers-coffee-tea-towel",
    "name": "Strangers Coffee Tea Towel"
  },
  "in-store-gift-card": {
    "id": "in-store-gift-card",
    "name": "In-store Gift Card"
  },
  "online-gift-card": {
    "id": "online-gift-card",
    "name": "Online Gift Card"
  }
});

const slugById = new Map(Object.entries(productRoutes).map(([slug, { id }]) => [id, slug]));

export function productPath(product) {
  const slug = slugById.get(product.id) ?? (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product.id) ? product.id : '');
  return slug ? `/coffee/p/${slug}/` : '/coffee/';
}

export function productFromPath(path, catalogue = []) {
  const slug = /^\/coffee\/p\/([a-z0-9-]+)\/?$/.exec(path)?.[1];
  if (!slug) return null;
  const baseline = Object.hasOwn(productRoutes, slug) ? productRoutes[slug] : null;
  return catalogue.find(item => item.id === (baseline?.id ?? slug)) ?? baseline;
}
