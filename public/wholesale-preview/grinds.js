// Stable IDs keep configured baskets and immutable order snapshots meaningful after catalogue edits.
export const defaultGrinds = [{ id: 'beans', label: 'Beans', enabled: true }, { id: 'espresso', label: 'Espresso / Fine', enabled: true }, { id: 'moka', label: 'Moka Pot / Fine', enabled: true }, { id: 'filter', label: 'Filter / Medium', enabled: true }, { id: 'cafetiere', label: 'Cafetiere / Coarse', enabled: true }];
export const validGrindId = id => typeof id === 'string' && (defaultGrinds.some(option => option.id === id) || /^grind-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id));
export const grindOptions = product => product?.grindOptions ?? defaultGrinds;
export const availableGrinds = product => grindOptions(product).filter(option => option.enabled);
export const grindLabel = (product, id) => grindOptions(product).find(option => option.id === id)?.label || defaultGrinds.find(option => option.id === id)?.label || 'Unavailable grind';
export const isGrindAvailable = (product, id) => availableGrinds(product).some(option => option.id === id);
