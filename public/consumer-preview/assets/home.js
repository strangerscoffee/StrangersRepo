import { escapeHtml as html } from './html.js';
import { productPath } from './product-paths.js';
import { originalProduct } from './products.js';
import { money } from './store.js';

const highlights = new Map([
  ['bom-jesus', 'Fazenda Bom Jesus'],
  ['rocko', 'Rocko Mountain'],
  ['anserma', 'Anserma'],
]);

export function showHighlights(products) {
  const shelf = document.querySelector('#home-roasting-grid');
  const available = products.filter(product => !product.category && product.available !== false);
  const byId = new Map(available.map(product => [product.id, product]));
  const chosen = [...highlights.keys()].map(id => byId.get(id)).filter(Boolean);
  chosen.push(...available.filter(product => !highlights.has(product.id)).slice(0, 3 - chosen.length));
  if (!chosen.length) {
    shelf.replaceChildren();
    document.querySelector('#home-roasting-intro').textContent = 'Explore the full coffee range online.';
    return;
  }
  shelf.innerHTML = chosen.map(product => `<article class="home-coffee">
    <figure><a tabindex="-1" aria-hidden="true" href="${html(productPath(product))}"><img src="${html(product.image)}" width="580" height="410" alt="" loading="lazy" decoding="async"></a></figure>
    <div class="home-coffee-copy"><p class="eyebrow">${[product.country, product.process].filter(Boolean).map(html).join(' · ')}</p>
    <h3>${html(product.name === originalProduct(product.id)?.name ? highlights.get(product.id) ?? product.name : product.name)}</h3><p>${html(product.notes.join(', '))}</p>
    <div class="home-coffee-actions"><strong>From ${money(Math.min(...Object.values(product.prices)))}</strong><a class="button outline" href="${html(productPath(product))}" aria-label="View ${html(product.name)}">View coffee</a></div>
    </div></article>`).join('');
}

function validPost(post) {
  if (!post || typeof post !== 'object' || typeof post.label !== 'string' ||
      !/^[A-Za-z0-9_-]{3,35}$/.test(post.code) || typeof post.href !== 'string') return false;
  return ['p', 'reel', 'tv'].some(type => post.href === `https://www.instagram.com/${type}/${post.code}/`);
}

async function socialCard(post) {
  const image = new Image(500, 500);
  image.alt = '';
  image.decoding = 'async';
  image.src = `/consumer-social/photo/${post.code}`;
  await image.decode();
  const link = document.createElement('a');
  link.href = post.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-label', (post.label || 'Strangers Coffee') + ' on Instagram');
  link.append(image);
  return link;
}

async function refreshSocial(grid) {
  try {
    const response = await fetch('/consumer-social/posts', {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) return;
    const payload = await response.json();
    if (!Array.isArray(payload?.posts)) return;
    const posts = payload.posts.filter(validPost).slice(0, 3);
    if (posts.length < 3) return;
    const cards = await Promise.all(posts.map(socialCard));
    if (!grid.contains(document.activeElement)) grid.replaceChildren(...cards);
  } catch {
    // The bundled Strangers posts remain available during upstream outages.
  }
}

export function populateHome() {
  const grid = document.querySelector('#home-social-posts');
  if (!grid || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    void refreshSocial(grid);
  }, { rootMargin: '360px' });
  observer.observe(grid);
}
