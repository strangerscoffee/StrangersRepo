import { grindLabel, sizeNames } from './checkout.js';
import { escapeHtml as html } from './html.js';
import { productPath } from './product-paths.js';
import { originalProduct } from './products.js';
import { money } from './store.js';

const brews = [
  { value: 'Espresso / Fine', label: 'Espresso', detail: 'Espresso machine', guide: ['espresso', 'Espresso recipe'], concentrated: true },
  { value: 'Filter / Medium', label: 'Filter', detail: 'Pour-over or drip', guide: ['v60', 'V60 recipe'] },
  { value: 'Cafetiere / Coarse', label: 'Cafetière', detail: 'French press', guide: ['french-press', 'Cafetière recipe'] },
  { value: 'Moka Pot / Fine', label: 'Moka pot', detail: 'Stovetop brewer', concentrated: true },
  { value: 'Whole bean', label: 'I grind my own', detail: 'Whole beans for any brewer' },
];

const tastes = [
  { value: 'Chocolatey', label: 'Chocolate & nuts', detail: 'Rounded and familiar', tone: 'chocolate' },
  { value: 'Fruity', label: 'Bright & fruity', detail: 'Berries, citrus and tropical fruit', tone: 'fruit' },
  { value: 'Any', label: 'Surprise me', detail: 'A little variety to explore', tone: 'brew' },
];

const caffeineOptions = [
  { value: 'regular', label: 'Regular' },
  { value: 'half', label: 'Half caff' },
  { value: 'decaf', label: 'Decaf' },
];

export const tastingFlightId = 'roasters-tasting-flight';

const preference = {
  Chocolatey: ['bom-jesus', 'honduras-rosalina-ramos-natural', 'colombia-campo-santo-washed', 'roasters-blend'],
  Fruity: ['rocko', 'cherry-bomb', 'anserma', 'ethiopia-idido-anaerobic-natural'],
  Any: ['anserma', 'bom-jesus', 'rocko'],
};
const concentratedPreference = {
  Chocolatey: ['roasters-blend', 'bom-jesus', 'honduras-rosalina-ramos-natural'],
  Fruity: ['anserma', 'rocko', 'cherry-bomb'],
  Any: ['anserma', 'roasters-blend', 'bom-jesus'],
};

const reasons = {
  'bom-jesus': ['Chocolate and praline', 'A rounded Brazil with chocolate, hazelnut and praline. A good fit if you like a familiar, nutty cup.'],
  'roasters-blend': ['Darker and fuller', 'A more developed roast with dark chocolate and cinder toffee. It suits a concentrated brew.'],
  'honduras-rosalina-ramos-natural': ['Sweeter and rounder', 'Hazelnut praline brings a familiar sweetness, with dried fig for a little more fruit.'],
  'colombia-campo-santo-washed': ['A brighter cup', 'Milk chocolate and caramel keep it mellow, with a little orange to lift the cup.'],
  anserma: ['Fruit and chocolate', 'Cherry and liqueur chocolate give this Colombian natural the character of Black Forest gateau.'],
  rocko: ['Berry-forward', 'Blueberry and strawberry are up front, with chocolate underneath.'],
  'cherry-bomb': ['Bolder and fruitier', 'Ripe cherry is followed by white peach and guava. A good fit if you want a more expressive cup.'],
  decaf: ['Decaffeinated', 'Sugar cane decaffeination gives you a cup with dark chocolate, hazelnut and a little orange.'],
  'half-caff-blend': ['Half caff', 'Chocolate and hazelnut make for a round, familiar cup, with orange to finish.'],
};

function caffeine(product) {
  if (product.profile === 'Decaf') return 'decaf';
  return product.id === 'half-caff-blend' ? 'half' : 'regular';
}

export function finderVariant(product, brew) {
  if (!product || product.available === false || !product.grinds?.length) return null;
  const preferred = product.id === tastingFlightId ? '300g' : '250g';
  const size = Object.hasOwn(product.prices, preferred) ? preferred : Object.keys(product.prices)[0];
  if (!Object.hasOwn(product.prices, size)) return null;
  const grind = product.grinds.includes(brew) ? brew : product.grinds[0];
  return { size, grind, price: product.prices[size] };
}

export function availableTastingFlight(products) {
  const flight = products.find(product => product.id === tastingFlightId);
  return flight && finderVariant(flight, '') && flight.contents?.length && flight.contents.every(id =>
    products.some(product => product.id === id && product.available !== false)) ? flight : null;
}

function matchingCoffees(products, answers) {
  const brew = brews.find(({ value }) => value === answers.brew);
  const weights = (brew?.concentrated ? concentratedPreference : preference)[answers.taste] ?? preference.Any;
  const score = product => {
    const index = weights.indexOf(product.id);
    return (product.profile === answers.taste ? 12 : 0) +
      (index === -1 ? 0 : weights.length - index) +
      (product.grinds.includes(answers.brew) ? 1 : 0);
  };
  return products.filter(product => !product.category && caffeine(product) === answers.caffeine &&
      finderVariant(product, answers.brew))
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3);
}

export const finderOptions = { brew: brews, taste: tastes, caffeine: caffeineOptions };
export function updateFinderAnswers(form, answers) {
  const groups = form.dataset.step === 'brew' ? ['brew'] : ['taste', 'caffeine'];
  const values = {};
  for (const group of groups) {
    const value = form.elements[group].value;
    const allowed = finderOptions[group].some(option => option.value === value);
    if (!allowed) return false;
    values[group] = value;
  }
  Object.assign(answers, values);
  form.querySelector('.finder-next').disabled = false;
  return true;
}

function choices(name, answers) {
  return finderOptions[name].map(({ value, label, detail, tone = 'brew' }) => `<label class="finder-option" data-tone="${tone}">
    <input type="radio" name="${name}" value="${html(value)}" required ${value === answers[name] ? 'checked' : ''}>
    <span class="finder-option-copy"><strong>${html(label)}</strong>${detail ? `<small>${html(detail)}</small>` : ''}</span>
    <span class="finder-tick" aria-hidden="true"></span>
  </label>`).join('');
}

const steps = ['Brew', 'Taste', 'Match'];
function progress(step) {
  const current = steps.findIndex(label => label.toLowerCase() === step);
  return `<div class="finder-progress" aria-label="Progress">${steps.map((label, index) =>
    `<span ${index < current ? 'class="is-complete"' : ''} ${index === current ? 'aria-current="step"' : ''}>${label}</span>`).join('')}</div>`;
}

function question(step, answers) {
  const brew = step === 'brew';
  const heading = brew ? 'How do you brew?' : 'What flavours do you enjoy?';
  return `<div class="finder"><div class="finder-stage" data-step="${step}">
    <figure class="finder-visual"><img src="/consumer-preview/assets/${brew ? 'finder-brew' : 'finder-taste'}.webp" alt="" width="620" height="420"></figure>
    <div class="finder-content">
      ${progress(step)}
      <h3 class="finder-heading" id="finder-heading" tabindex="-1">${heading}</h3>
      <p class="finder-intro">${brew ? 'We’ll suggest a grind for your setup.' : 'Pick the flavours you’d like in your cup.'}</p>
      <form class="finder-form" id="finder-form" data-step="${step}">
        <fieldset aria-labelledby="finder-heading"><div class="finder-options ${brew ? 'finder-brews' : 'finder-tastes'}">${choices(step, answers)}</div></fieldset>
        ${brew ? '' : `<fieldset class="finder-caffeine"><legend>Caffeine preference</legend><div class="finder-options">${choices('caffeine', answers)}</div></fieldset>`}
        <div class="finder-actions">
          ${brew ? '' : '<button class="button outline finder-back" type="button" data-finder-back="brew">Back</button>'}
          <button class="button primary finder-next" type="submit" ${answers[step] ? '' : 'disabled'}>${brew ? 'Continue to taste' : 'Find my match'}</button>
        </div>
      </form>
    </div>
  </div></div>`;
}

function finderProductPath(product, grind) {
  return productPath(product) + '?' + new URLSearchParams({ grind });
}

function match(product, brew, originLabel) {
  const { size, grind, price } = finderVariant(product, brew.value);
  const origin = [product.country, product.process].filter(Boolean).map(html).join(' · ');
  const sameNotes = product.shortCopy === originalProduct(product.id)?.shortCopy;
  const reason = sameNotes ? reasons[product.id]?.[1] ?? product.shortCopy : product.shortCopy;
  return `<article class="finder-best">
    <div class="finder-best-photo"><img src="${html(product.image)}" width="580" height="410" alt="${html(product.name)} coffee artwork"><span class="finder-best-tag">${originLabel}</span></div>
    <div class="finder-best-copy">
      <p class="finder-best-origin">${origin}</p><h4>${html(product.name)}</h4>
      <p class="finder-best-notes">${html(product.notes.join(', '))}</p>
      <p class="finder-best-reason">${html(reason)}</p>
      <div class="finder-best-grind"><strong>${html(grindLabel(grind))}</strong>${brew.guide ? `<a data-finder-guide href="/brewguides/#${brew.guide[0]}">${brew.guide[1]}</a>` : '<a href="/brewguides/">Brew guides</a>'}</div>
      <div class="finder-best-actions"><button class="button" type="button" data-finder-add="${html(product.id)}"><span data-finder-add-label>Add</span> ${html(sizeNames[size] ?? size)} · ${money(price)}</button><a href="${html(finderProductPath(product, grind))}">Coffee details</a></div>
      <p class="finder-add-error" role="alert" hidden></p>
    </div>
  </article>`;
}

function alternative(product, brew) {
  const variant = finderVariant(product, brew.value);
  const difference = reasons[product.id]?.[0] ?? product.country;
  return `<article class="finder-alternative">
    <img src="${html(product.image)}" width="300" height="240" alt="" loading="lazy">
    <div><p class="eyebrow">${html(difference)}</p><h5><a href="${html(finderProductPath(product, variant.grind))}">${html(product.name)}</a></h5>
    <p>${html(product.notes.join(', '))}</p>
    <button type="button" class="text-button" data-finder-add="${html(product.id)}"><span data-finder-add-label>Add</span> ${html(sizeNames[variant.size] ?? variant.size)} · ${money(variant.price)}</button><p class="finder-add-error" role="alert" hidden></p></div>
  </article>`;
}

function tastingFlight(product) {
  const { price, grind, size } = finderVariant(product, '');
  return `<article class="finder-alternative finder-flight">
    <div><p class="eyebrow">${html(sizeNames[size] ?? size)} · ${html(grindLabel(grind))}</p><h5><a href="${html(productPath(product))}">${html(product.name)}</a></h5>
      <p>${html(product.shortCopy)}</p>
      <button type="button" class="text-button" data-finder-add="${html(product.id)}"><span data-finder-flight-label>Add flight</span> · ${money(price)}</button><p class="finder-add-error" role="alert" hidden></p></div>
  </article>`;
}

export function finderMarkup(step, products, answers) {
  if (step !== 'match') return question(step, answers);
  const brew = brews.find(({ value }) => value === answers.brew) ?? brews[1];
  const taste = tastes.find(({ value }) => value === answers.taste) ?? tastes[2];
  const caff = caffeineOptions.find(({ value }) => value === answers.caffeine) ?? caffeineOptions[0];
  const [product, ...others] = matchingCoffees(products, answers);
  const flight = answers.caffeine === 'regular' ? availableTastingFlight(products) : null;
  const fitsTaste = product?.profile === answers.taste || answers.taste === 'Any';
  return `<div class="finder finder-result" id="finder-result">
    <div class="finder-result-head"><div>
      <h3 class="finder-heading" tabindex="-1">Your coffee match</h3><p>${[['brew',brew],['taste',taste],['caffeine',caff]].map(([group,option])=>
        `<span data-finder-answer="${group}" data-value="${html(option.value)}">${html(option.label)}</span>`).join(' · ')}</p>
    </div><button class="button outline finder-change" type="button" data-finder-back="brew">Change answers</button></div>
    ${product ? match(product, brew, fitsTaste ? 'Best match' : 'Closest available match')
      : '<p class="finder-no-match">There isn’t an available coffee for these choices at the moment. Change your answers to explore the current range.</p>'}
    ${others.length || flight ? `<section class="finder-alternatives" aria-labelledby="finder-others">
      <h4 id="finder-others">Also worth trying</h4><div class="finder-alternative-grid">
      ${others.map(candidate => alternative(candidate, brew)).join('')}${flight ? tastingFlight(flight) : ''}</div></section>` : ''}
  </div>`;
}
