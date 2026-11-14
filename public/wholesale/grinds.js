// Stable IDs keep configured baskets and immutable order snapshots meaningful after catalogue edits.
// Each grind has a short name and what it's for (`hint`, shown smaller). The ids are the original ones, so
// saved baskets and past orders still match: espresso is now Fine, filter Medium and cafetiere Coarse.
// The first available option is the one each coffee starts on: Beans.
export const defaultGrinds = [
  { id: 'beans', label: 'Beans', hint: 'Whole beans, for your own grinder', enabled: true },
  { id: 'espresso', label: 'Fine', hint: 'Commercial espresso machine', enabled: true },
  { id: 'filter', label: 'Medium', hint: 'Filter', enabled: true },
  { id: 'cafetiere', label: 'Coarse', hint: 'Cafetiere and batch brewers', enabled: true },
];
// No longer offered, but still recognised so old baskets and orders read as "no longer offered", not as invalid.
const RETIRED_GRINDS = { moka: 'Moka Pot / Fine' };
export const validGrindId = id => typeof id === 'string' && (defaultGrinds.some(option => option.id === id) || Object.hasOwn(RETIRED_GRINDS, id) || /^grind-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id));
export const grindOptions = product => product?.grindOptions ?? defaultGrinds;
export const availableGrinds = product => grindOptions(product).filter(option => option.enabled);
export const grindLabel = (product, id) => grindOptions(product).find(option => option.id === id)?.label || defaultGrinds.find(option => option.id === id)?.label || RETIRED_GRINDS[id] || 'Unavailable grind';
export const grindHint = (product, id) => grindOptions(product).find(option => option.id === id)?.hint || '';
export const isGrindAvailable = (product, id) => availableGrinds(product).some(option => option.id === id);
