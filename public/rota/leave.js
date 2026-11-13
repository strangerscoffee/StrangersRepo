// Holiday dashboard. Private state lives only in memory and is cleared with the shared session guard.
window.SCLeave = function createLeaveUI(c) {
    const { el, btn, ghost, label, empty, api, get, openSheet, closeSheets, cancelLink, setHead, go, R, mgr, toast, render, fmt, shortM, addDays, monday, londonToday } = c;
    let month = '', year = '', yearPicked = false, employee = '', generation = 0;
    const TYPE = { annual: 'Annual leave', sick: 'Sick leave', unpaid: 'Unpaid leave', unauthorised: 'Unauthorised absence', legacy: 'Unclassified time off' };
    const STAT = { requested: 'Pending', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' };
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const SITES = { all: 'All sites', roastery: 'Roastery', cafe: 'Cafe', asg: 'ASG', factory: 'Factory' };
    const field = (name, title, input, wide = false) => el('div', { class: 'field' + (wide ? ' wide' : '') }, el('label', { class: 'label', for: name, text: title }), Object.assign(input, { id: name }));
    const input = (name, value = '', extra = {}) => el('input', { type: 'text', name, value, ...extra });
    const number = (name, value = '', extra = {}) => input(name, value, { type: 'number', min: 0, step: '0.01', ...extra });
    const select = (name, options, value) => el('select', { name, id: name }, ...options.map(([v, t]) => el('option', { value: v, selected: v === value, text: t })));
    const message = () => el('p', { class: 'smsg', role: 'alert' });
    const span = (a, b) => a === b ? shortM(a) : `${shortM(a)} – ${shortM(b)}`;
    const amount = n => new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 }).format(n);
    const chargeText = days => Object.entries(days.reduce((out, d) => { out[d.unit] = (out[d.unit] || 0) + d.amount; return out; }, {})).map(([u, n]) => `${amount(n)} ${u}`).join(' · ');
    const note = t => el('p', { class: 'note', text: t });
    const check = (name, text, checked = false) => { const i = input(name, '', { type: 'checkbox', checked }); return { input: i, node: el('label', { class: 'leave-check' }, i, el('span', { text })) }; };
    const errorText = e => e.message || "Couldn't save. Check your connection and try again.";
    function clear() { generation++; month = ''; year = ''; yearPicked = false; employee = ''; }
    async function dashboard() {
        const token = generation;
        const data = await get('/api/rota/leave/dashboard');
        if (token !== generation)
            return [];
        month = month || londonToday().slice(0, 7) + '-01';
        const start = monday(month), last = addDays(start, 41);
        const calendar = await get(`/api/rota/leave/calendar?from=${start}&to=${last}`);
        if (token !== generation)
            return [];
        const current = data.balances.find(b => b.from <= londonToday() && b.to >= londonToday());
        const b = yearPicked ? data.balances.find(b => b.from === year) || current : current;
        year = b?.from || '';
        setHead('leave', 'Holidays', b ? `${fmt(b.from, { day: "numeric", month: "short", year: "numeric" })} – ${fmt(b.to, { day: "numeric", month: "short", year: "numeric" })}` : 'Your holiday allowance and team calendar', {
            actions: [mgr() ? ghost('Manage leave', () => go('leave-admin')) : null, btn('Request leave', () => request(), 'btn', { disabled: !data.enabled })].filter(Boolean)
        });
        const out = [];
        if (!data.enabled)
            out.push(el('section', { class: 'panel' }, el('h2', { text: 'Holiday management is awaiting setup' }), note(mgr() ? 'Set the leave policy and each employee’s allowance before enabling requests.' : 'An admin will set up your leave year, allowance and working pattern.'), mgr() ? btn('Set up holiday management', () => go('leave-admin')) : null));
        if (b) {
            const stats = [[b.to < londonToday() ? 'Unused in this year' : 'Available to book', b.available], ['Used', b.used], ['Booked ahead', b.booked], ['Pending', b.pending]];
            out.push(el('div', { class: 'leave-stats' }, ...stats.map(([t, n]) => el('div', { class: 'stat glass' }, el('span', { text: t }), el('b', { text: amount(n) }), el('small', { text: b.unit })))));
            const years = select('leave_year', data.balances.map(y => [y.from, `${y.from} – ${y.to}`]), b.from);
            years.setAttribute('aria-label', 'Leave year');
            years.onchange = () => { year = years.value; yearPicked = true; render(); };
            out.push(el('section', { class: 'panel leave-allowance' }, el('div', { class: 'row between' }, el('h2', { text: 'Your allowance' }), years), note(`${amount(b.entitlement)} days entitlement${b.carry ? ` + ${amount(b.carry)} days approved carry-over` : ''}. ${amount(b.remaining)} days remain before pending requests and reserved bank holidays.`), b.bankHolidayReserved ? note(`${amount(b.bankHolidayReserved)} days are reserved for your bank holidays. A confirmed worked bank holiday releases its day to book later.`) : null, b.credits ? note(`${amount(b.credits)} bank-holiday ${b.credits === 1 ? 'day' : 'days'} released to use in lieu. Included in “Available to book”.`) : null, b.note ? note(b.note) : null, b.openingUsed ? note(`Includes ${amount(b.openingUsed)} days previously used, reconciled through ${shortM(b.openingAsOf)}.`) : null));
        }
        else if (data.enabled)
            out.push(el('section', { class: 'panel' }, el('h2', { text: 'Your allowance needs setting up' }), note('Ask an admin to enter your own entitlement and normal working days. No allowance has been assumed.')));
        if (!b && data.balances.length) {
            const past = select('leave_past_year', [['', 'Choose a leave year'], ...data.balances.map(y => [y.from, `${y.from} – ${y.to}`])], '');
            past.setAttribute('aria-label', 'Other leave years');
            past.onchange = () => { year = past.value; yearPicked = !!year; render(); };
            out.push(el('section', { class: 'panel' }, el('h2', { text: 'Other leave years' }), past));
        }
        if (data.legacyCount)
            out.push(note(`${data.legacyCount} existing time-off record${data.legacyCount === 1 ? ' needs' : 's need'} admin reconciliation. Unclassified records are retained on the rota and are not silently deducted from your allowance.`));
        out.push(calendarView(calendar));
        out.push(label('Your requests and absences'), absenceList(data.absences, false));
        return out;
    }
    function changeMonth(delta) { const d = new Date(month + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta); month = d.toISOString().slice(0, 7) + '-01'; render(); }
    function calendarView(data) {
        const heading = el('div', { class: 'leave-calendar-head' }, el('h2', { text: fmt(month, { month: 'long', year: 'numeric' }) }), el('div', { class: 'row' }, ghost('‹', () => changeMonth(-1), { 'aria-label': 'Previous month' }), ghost('Today', () => { month = londonToday().slice(0, 7) + '-01'; render(); }), ghost('›', () => changeMonth(1), { 'aria-label': 'Next month' })));
        const grid = el('div', { class: 'leave-calendar', role: 'group', 'aria-label': 'Holiday calendar' });
        DAYS.forEach(d => grid.append(el('div', { class: 'leave-weekday', text: d.slice(0, 3), 'aria-hidden': 'true' })));
        for (let i = 0; i < 42; i++) {
            const day = addDays(data.from, i), holidays = data.holidays.filter(h => h.day === day), rules = data.days.find(d => d.day === day);
            const closed = rules?.blocked, mine = holidays.some(h => h.mine), outside = day.slice(0, 7) !== month.slice(0, 7);
            const tile = el('button', { type: 'button', class: 'leave-day' + (outside ? ' outside' : '') + (closed ? ' blocked' : '') + (day === londonToday() ? ' today' : ''), 'data-leave-day': day, 'aria-label': `${fmt(day, { weekday: 'long', day: 'numeric', month: 'long' })}${closed ? ', holiday requests blocked' : ''}${holidays.length ? `, ${holidays.map(h => h.name).join(', ')} on annual leave` : ''}`, onclick: () => dayDetails(day, holidays, rules, data.enabled) }, el('b', { text: String(Number(day.slice(8))) }), closed ? el('span', { class: 'leave-block-label', text: 'Blocked' }) : null, ...holidays.slice(0, 2).map(h => el('span', { class: 'leave-person' + (h.mine ? ' own' : ''), text: h.mine ? 'You' : h.name })), holidays.length > 2 ? el('span', { class: 'leave-more', text: `+${holidays.length - 2}` }) : null);
            if (mine)
                tile.dataset.own = '';
            grid.append(tile);
        }
        return el('section', { class: 'panel leave-calendar-panel' }, heading, note('Approved annual leave only. Other absence types, notes and balances are private.'), el('div', { class: 'leave-calendar-scroll', tabindex: 0, role: 'region', 'aria-label': 'Month calendar; scroll horizontally on small screens' }, grid), el('div', { class: 'leave-legend' }, el('span', { text: '● Your holiday', class: 'own' }), el('span', { text: '● Team holiday' }), el('span', { text: '▧ Requests blocked' })));
    }
    function dayDetails(day, holidays, rules, enabled) {
        openSheet(fmt(day, { weekday: 'long', day: 'numeric', month: 'long' }), el('div', { class: 'sbody' }, holidays.length ? el('div', { class: 'list glass' }, ...holidays.map(h => el('div', { class: 'lrow' }, el('span', { class: 't' }, el('b', { text: h.name }), el('span', { class: 's', text: 'Approved annual leave' }))))) : note('No approved annual leave on this date.'), rules?.blocked ? el('div', { class: 'leave-notice' }, el('b', { text: 'Holiday requests blocked' }), ...rules.reasons.map(note)) : null, el('div', { class: 'sfoot' }, btn('Request leave', () => request(day), 'btn', { disabled: !enabled || rules?.blocked || day < londonToday() }))), { left: cancelLink() });
    }
    function absenceList(absences, admin) {
        if (!absences.length)
            return empty('No leave requests or absence records yet.');
        return el('div', { class: 'list glass' }, ...absences.map(t => el('div', { class: 'lrow wraprow leave-record', 'data-absence': t.id }, el('span', { class: 'tile ' + ({ annual: 'blue', sick: 'orange', unpaid: 'grey', unauthorised: 'red', legacy: 'grey' }[t.kind] || 'grey'), text: t.kind === 'annual' ? '↗' : '–', 'aria-hidden': 'true' }), el('span', { class: 't' }, el('b', { text: (admin && t.name ? `${t.name} · ` : '') + (TYPE[t.kind] || 'Time off') }), el('span', { class: 's', text: span(t.from, t.to) + (t.fromTime ? ` · ${t.fromTime}–${t.toTime}` : '') }), t.days.length ? el('span', { class: 's', text: chargeText(t.days) }) : null, t.reason ? el('span', { class: 's', text: t.reason }) : null, t.coveredByOpening ? el('span', { class: 's', text: 'Past days reconciled in opening used balance' }) : null), el('span', { class: 'pill ' + ({ requested: 'warn', approved: 'ok', declined: 'bad' }[t.status] || ''), text: STAT[t.status] || t.status }), admin ? ghost('Review', () => review(t)) : (!t.coveredByOpening && ['requested', 'approved'].includes(t.status) && ['annual', 'unpaid', 'legacy'].includes(t.kind) && (t.status === 'requested' || t.from >= londonToday()) ? ghost('Cancel', () => cancel(t)) : null))));
    }
    function cancel(t) {
        const msg = message();
        openSheet('Cancel this leave?', el('div', { class: 'sbody' }, note(`${TYPE[t.kind] || 'Time off'} · ${span(t.from, t.to)}`), note('The booking will be removed from the rota and any reserved holiday allowance will be returned.'), msg, el('div', { class: 'sfoot' }, btn('Cancel leave', async () => { try {
            await api('PATCH', `/api/rota/leave/requests/${t.id}`, { status: 'cancelled', ifVersion: t.version });
            closeSheets();
            toast('Leave cancelled.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }, 'btn danger'))), { left: cancelLink() });
    }
    async function request(day, uid, adminData) {
        const token = generation;
        try {
            const data = await get('/api/rota/leave/dashboard' + (uid ? '?userId=' + encodeURIComponent(uid) : ''));
            if (token !== generation)
                return;
            const from = input('leave_from', day || addDays(londonToday(), 14), { type: 'date', min: mgr() ? undefined : londonToday() }), to = input('leave_to', from.value, { type: 'date', min: from.value });
            from.onchange = () => { to.min = from.value; if (to.value < from.value)
                to.value = from.value; };
            const portion = select('leave_portion', [['1', 'Full days'], ['0.5', 'Half day']], '1');
            const fromTime = input('leave_from_time', '', { type: 'time' }), toTime = input('leave_to_time', '', { type: 'time' });
            const timeFields = el('div', { class: 'sfields wide', hidden: true }, field('leave_from_time', 'Absence starts', fromTime), field('leave_to_time', 'Absence ends', toTime));
            portion.onchange = () => { timeFields.hidden = portion.value === '1'; if (portion.value === '0.5')
                to.value = from.value; };
            const kind = select('leave_kind', data.types.map(t => [t.id, t.label]), 'annual');
            const reason = el('textarea', { name: 'reason', maxlength: 200, rows: 2, placeholder: 'Optional, visible only to you and admins' }), msg = message(), key = crypto.randomUUID();
            const approved = check('leave_approved', 'Record as approved', !!uid);
            const form = el('div', { class: 'sfields' }, field('leave_kind', 'Absence type', kind, true), field('leave_portion', 'Length', portion, true), field('leave_from', 'First day', from), field('leave_to', 'Last day', to), timeFields, field('leave_reason', 'Private note (optional)', reason, true));
            const body = () => ({ ...(uid ? { userId: uid } : {}), kind: kind.value, portion: Number(portion.value), fromTime: portion.value === '0.5' ? fromTime.value : null, toTime: portion.value === '0.5' ? toTime.value : null, from: from.value, to: to.value, reason: reason.value, approved: mgr() && approved.input.checked, requestKey: key });
            let pending = null;
            const output = el('div'), confirm = btn('Submit request', async () => {
                try {
                    pending = pending || { ...body(), expectedCharges: confirm._charges };
                    form.querySelectorAll('input,select,textarea').forEach(n => n.disabled = true);
                    preview.disabled = true;
                    const saved = await api('POST', '/api/rota/leave/requests', pending);
                    if (!saved.absence?.id)
                        throw Object.assign(new Error('The response could not be confirmed.'), { code: 'unavailable' });
                    closeSheets();
                    toast(approved.input.checked && mgr() ? 'Absence recorded.' : 'Request sent for admin approval.');
                    render();
                }
                catch (e) {
                    if (e.code === 'unavailable' || !e.status) {
                        msg.textContent = 'The response was not confirmed. Check this same request before changing the dates.';
                        confirm.textContent = 'Check request';
                    }
                    else {
                        pending = null;
                        form.querySelectorAll('input,select,textarea').forEach(n => n.disabled = false);
                        preview.disabled = false;
                        msg.textContent = errorText(e);
                        confirm.hidden = true;
                        output.replaceChildren();
                    }
                }
            });
            confirm.hidden = true;
            const preview = btn('Review request', async () => {
                try {
                    msg.textContent = '';
                    const p = await api('POST', '/api/rota/leave/preview', body());
                    if (token !== generation)
                        return;
                    confirm._charges = p.days;
                    output.replaceChildren(el('div', { class: 'leave-notice' }, el('b', { text: TYPE[p.kind] }), note(span(p.from, p.to)), note(p.days.length ? `${chargeText(p.days)} will be reserved from your allowance.` : 'This absence does not use annual holiday allowance.'), p.shiftConflicts.length ? note(`${p.shiftConflicts.length} assigned shift(s) fall within these dates. Approved absence appears on the rota; an admin must resolve those shifts.`) : null));
                    confirm.hidden = false;
                }
                catch (e) {
                    msg.textContent = errorText(e);
                    confirm.hidden = true;
                    output.replaceChildren();
                }
            });
            form.addEventListener('input', () => { confirm.hidden = true; output.replaceChildren(); });
            form.addEventListener('change', () => { confirm.hidden = true; output.replaceChildren(); });
            approved.input.onchange = () => { confirm.hidden = true; output.replaceChildren(); };
            openSheet(uid ? 'Record employee absence' : 'Request leave', el('div', { class: 'sbody' }, form, mgr() ? approved.node : null, note('Only configured working days are charged. For a half day, enter the actual absence times so the rota can still offer shifts outside that period.'), output, msg, el('div', { class: 'sfoot' }, preview, confirm)), { left: cancelLink() });
        }
        catch (e) {
            toast(errorText(e));
        }
    }
    async function admin() {
        const token = generation, data = await get('/api/rota/leave/admin');
        if (token !== generation)
            return [];
        employee = employee || data.people[0]?.id || '';
        const person = data.people.find(p => p.id === employee), own = employee ? await get('/api/rota/leave/dashboard?userId=' + encodeURIComponent(employee)) : null;
        if (token !== generation)
            return [];
        setHead('leave-admin', 'Holiday management', 'Allowances, requests and absence records', { back: ['Holidays', 'leave'], actions: [ghost('Policy & limits', () => settings(data)), btn('Record absence', () => request(undefined, employee, data), 'btn', { disabled: !employee || !data.settings.enabled })] });
        const pick = select('leave_employee', data.people.map(p => [p.id, p.name]), employee);
        pick.setAttribute('aria-label', 'Employee');
        pick.onchange = () => { employee = pick.value; document.querySelectorAll('#page button,#pageAction button').forEach(b => b.disabled = true); render(); };
        const out = [el('section', { class: 'panel' }, el('div', { class: 'row between' }, el('h2', { text: 'Employee allowance' }), pick), note(`${data.setup.filter(p => !p.configured).length} employees need a current leave-year allowance.`), el('div', { class: 'row' }, btn('Set up a leave year', () => allowance(person, undefined, data.settings)), ghost('Add blackout dates', () => blackout())), ...(own?.balances || []).map(b => el('div', { class: 'leave-year-row' }, el('span', { class: 't' }, el('b', { text: `${b.from} – ${b.to}` }), el('span', { class: 's', text: `${amount(b.available)} days available · ${amount(b.used)} used · ${amount(b.booked)} booked · ${amount(b.pending)} pending${b.bankHolidayReserved ? ` · ${amount(b.bankHolidayReserved)} reserved for bank holidays` : ''}` })), ghost('Edit', () => allowance(person, b, data.settings)), b.bankHolidayEligible && data.settings.bankHolidayPolicy === 'credit-worked' ? ghost('Bank holiday worked', () => credit(person, b)) : null)))];
        out.push(label(`Requests awaiting a decision · ${data.requests.length}`), absenceList(data.requests, true));
        out.push(label(person ? `${person.name} · absence history` : 'Absence history'), absenceList((own?.absences || []).filter(a => a.status !== 'requested'), true));
        out.push(label('Blackout dates'), data.blocks.length ? el('div', { class: 'list glass' }, ...data.blocks.map(b => el('div', { class: 'lrow wraprow' }, el('span', { class: 't' }, el('b', { text: b.title }), el('span', { class: 's', text: `${span(b.from, b.to)} · ${SITES[b.site || 'all']}` })), ghost('Remove', () => removeBlock(b))))) : empty('No blackout dates set.'));
        return out;
    }
    function leaveYearStart(policy) { const today = londonToday(), md = policy.yearStart || '04-01'; return (today.slice(5) < md ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4))) + '-' + md; }
    function allowance(person, b, policy) {
        if (!person)
            return;
        const from = input('allow_from', b?.from || leaveYearStart(policy), { type: 'date', disabled: !!b });
        const next = new Date(from.value + 'T12:00:00Z');
        next.setUTCFullYear(next.getUTCFullYear() + 1);
        const to = input('allow_to', b?.to || addDays(next.toISOString().slice(0, 10), -1), { type: 'date', disabled: !!b });
        from.onchange = () => { if (!from.value)
            return; const d = new Date(from.value + 'T12:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); to.value = addDays(d.toISOString().slice(0, 10), -1); };
        const entitlement = number('entitlement', b?.entitlement ?? ''), carry = number('carry', b?.carry ?? 0), openingUsed = number('openingUsed', b?.openingUsed ?? 0), openingAsOf = input('openingAsOf', b?.openingAsOf || '', { type: 'date', max: londonToday() });
        const weekly = DAYS.map((d, i) => number('weekly_' + i, b?.weekly[i] ?? 0, { max: 1, step: '0.5', 'aria-label': d + ' holiday charge' }));
        const excluded = input('excludedDates', (b?.excludedDates || []).join(', '), { placeholder: 'YYYY-MM-DD, YYYY-MM-DD' }), banks = input('bankHolidays', (b?.bankHolidays || []).join(', '), { placeholder: 'YYYY-MM-DD, YYYY-MM-DD' });
        const eligible = check('bankHolidayEligible', 'Full-time contract eligible for bank-holiday days in lieu', b?.bankHolidayEligible || false);
        const policyNote = el('textarea', { name: 'note', rows: 2, maxlength: 500, value: b?.note || '' }), why = input('changeReason', '', { maxlength: 300, placeholder: 'Required: agreed allowance, exceptional carry-over, or reconciliation' }), msg = message();
        const list = v => v.split(',').map(s => s.trim()).filter(Boolean);
        openSheet(`${person.name} · leave year`, el('div', { class: 'sbody' }, el('div', { class: 'sfields' }, field('allow_from', 'Leave year starts', from), field('allow_to', 'Leave year ends', to), field('allow_entitlement', 'Annual entitlement in days', entitlement), field('allow_carry', 'Admin-approved carry-over in days', carry), field('allow_used', 'Previously used in this year', openingUsed), field('allow_asof', 'Opening balance covers through', openingAsOf)), label('Normal holiday charge by weekday'), note('Set 1 for a normal working day and 0 for a rest day. These are holiday charges, separate from shift availability.'), el('div', { class: 'leave-weekly-fields' }, ...weekly.map((w, i) => field('allow_week_' + i, DAYS[i].slice(0, 3), w))), el('div', { class: 'sfields' }, field('allow_excluded', 'Additional non-working dates (no charge)', excluded, true), eligible.node, field('allow_banks', 'Bank-holiday dates reserved within the inclusive allowance', banks, true), ghost('Load England/Wales bank holidays', async () => { try {
            const data = await api("GET", `/api/rota/leave/bank-holidays?from=${from.value}&to=${to.value}`, undefined, {optionalDependency:true});
            const found = data.holidays.filter(h => !Number(openingUsed.value) || !openingAsOf.value || h.day > openingAsOf.value);
            if (!found.length) {
                msg.textContent = 'No published dates were found for this period. Keep the existing dates or enter them manually.';
                return;
            }
            banks.value = [...new Set([...list(banks.value), ...found.map(h => h.day)])].sort().join(', ');
            msg.textContent = 'Government dates added. Review which apply to this employee’s contract before saving.';
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }), field('allow_note', 'Policy note visible to the employee', policyNote, true), field('allow_reason', 'Reason for this admin change', why, true)), note('Bank-holiday dates reserve days already included in the entitlement. Confirming one was worked releases its day to use later; it does not add the same entitlement twice. Enter only dates that apply to this employee’s contract. Carry-over is entered only after an admin agrees an exception.'), msg, el('div', { class: 'sfoot' }, btn('Save allowance', async () => { try {
            await api('PUT', '/api/rota/leave/allowances', { userId: person.id, from: from.value, to: to.value, unit: 'days', entitlement: entitlement.value, carry: carry.value, openingUsed: openingUsed.value, openingAsOf: openingAsOf.value, weekly: weekly.map(w => w.value), excludedDates: list(excluded.value), bankHolidays: list(banks.value), bankHolidayEligible: eligible.input.checked, note: policyNote.value, changeReason: why.value, ifVersion: b?.version ?? 0 });
            closeSheets();
            toast('Allowance saved.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }))), { left: cancelLink() });
    }
    function settings(data) {
        const p = data.settings, on = check('leave_enabled', 'Enable holiday requests', p.enabled), yearStart = input('yearStart', p.yearStart || '04-01', { pattern: '[0-9]{2}-[0-9]{2}', placeholder: '04-01' });
        const bank = select('bankHolidayPolicy', [['unconfirmed', 'Awaiting contract review'], ['credit-worked', 'Inclusive allowance; release worked bank-holiday days in lieu'], ['included', 'Inclusive allowance; no separate worked-day process']], p.bankHolidayPolicy);
        const limits = Object.keys(SITES).map(key => [key, number('limit_' + key, p.limits[key] ?? '', { step: 1, max: 999 })]), msg = message();
        openSheet('Leave policy and limits', el('div', { class: 'sbody' }, on.node, el('div', { class: 'sfields' }, field('leave_year_start', 'Default leave-year start (MM-DD)', yearStart, true), field('leave_bank_policy', 'Bank-holiday policy', bank, true)), note('1 April to 31 March uses 04-01; 6 April to 5 April uses 04-06. Changing the default leaves existing yearly records unchanged.'), label('Maximum employees on annual leave per day'), note('Blank means no limit; 0 blocks new holiday requests. Site rules use each employee’s rota sites. Existing approvals are retained when a limit changes.'), el('div', { class: 'sfields' }, ...limits.map(([key, n]) => field('leave_limit_' + key, SITES[key], n))), msg, el('div', { class: 'sfoot' }, btn('Save policy', async () => { try {
            await api('PUT', '/api/rota/leave/settings', { enabled: on.input.checked, yearStart: yearStart.value, bankHolidayPolicy: bank.value, limits: Object.fromEntries(limits.map(([k, n]) => [k, n.value === '' ? null : Number(n.value)])), ifVersion: data.version });
            closeSheets();
            toast('Policy saved.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }))), { left: cancelLink() });
    }
    function blackout() {
        const from = input('block_from', londonToday(), { type: 'date' }), to = input('block_to', londonToday(), { type: 'date' }), title = input('block_title', '', { maxlength: 120, placeholder: 'e.g. Christmas trading' }), site = select('block_site', Object.entries(SITES), 'all'), msg = message();
        openSheet('Add holiday blackout', el('div', { class: 'sbody' }, el('div', { class: 'sfields' }, field('block_from', 'First day', from), field('block_to', 'Last day', to), field('block_site', 'Applies to', site, true), field('block_title', 'Label staff can see', title, true)), note('New annual-leave requests and approvals will be blocked. Existing bookings stay intact.'), msg, el('div', { class: 'sfoot' }, btn('Add blackout', async () => { try {
            await api('POST', '/api/rota/leave/blocks', { from: from.value, to: to.value, site: site.value === 'all' ? null : site.value, title: title.value });
            closeSheets();
            toast('Blackout added.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }))), { left: cancelLink() });
    }
    function removeBlock(b) { const msg = message(); openSheet('Remove this blackout?', el('div', { class: 'sbody' }, note(`${b.title} · ${span(b.from, b.to)}`), msg, el('div', { class: 'sfoot' }, btn('Remove blackout', async () => { try {
        await api('DELETE', `/api/rota/leave/blocks/${b.id}`, { ifVersion: b.version });
        closeSheets();
        render();
    }
    catch (e) {
        msg.textContent = errorText(e);
    } }))), { left: cancelLink() }); }
    function credit(person, b) {
        const day = input('credit_day', '', { type: 'date', min: b.from, max: [b.to, londonToday()].sort()[0] }), reason = input('credit_reason', '', { maxlength: 300, placeholder: 'Confirm which bank holiday was worked' }), worked = check('credit_worked', 'I confirm this full-time employee worked the bank holiday'), msg = message();
        openSheet('Release a bank-holiday day in lieu', el('div', { class: 'sbody' }, note(`${person.name}. One day already reserved in the inclusive allowance becomes available to book. Each date can be credited only once.`), note(`Reserved dates: ${(b.reservedDates || []).map(shortM).join(', ') || 'None'}`), ...(b.creditHistory || []).filter(c => !c.reversedAt).map(c => el('div', { class: 'leave-year-row' }, note(`${shortM(c.day)} · day in lieu released`), ghost('Correct', () => reverseCredit(person, b, c)))), el('div', { class: 'sfields' }, field('credit_day', 'Bank holiday worked', day, true), field('credit_reason', 'Admin record', reason, true)), worked.node, msg, el('div', { class: 'sfoot' }, btn('Release one day', async () => { try {
            await api('POST', '/api/rota/leave/credits', { userId: person.id, year: b.from, day: day.value, reason: reason.value, confirmWorked: worked.input.checked, ifVersion: b.version });
            closeSheets();
            toast('Bank-holiday day available to use in lieu.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }))), { left: cancelLink() });
    }
    function reverseCredit(person, b, c) {
        const reason = input('credit_correction', '', { maxlength: 300 }), msg = message();
        openSheet('Correct bank-holiday credit', el('div', { class: 'sbody' }, note(`${person.name} · ${shortM(c.day)}. The audit history is kept and the bank-holiday day will be reserved again.`), field('credit_correction', 'Reason for this correction', reason, true), msg, el('div', { class: 'sfoot' }, btn('Reverse this credit', async () => { try {
            await api('POST', '/api/rota/leave/credits/reverse', { userId: person.id, year: b.from, day: c.day, reason: reason.value, ifVersion: b.version });
            closeSheets();
            toast('Bank-holiday credit corrected.');
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }))), { left: cancelLink() });
    }
    async function review(t) {
        const token = generation;
        try {
            const data = await get('/api/rota/leave/requests/' + encodeURIComponent(t.id));
            if (token !== generation)
                return;
            t = { ...t, ...data.absence, balances: data.balances, shiftConflicts: data.shiftConflicts };
        }
        catch (e) {
            toast(errorText(e));
            return;
        }
        const covered = check('legacy_opening', 'The historical days are already included in the opening used balance');
        const classification = select('absence_classification', [['', 'Choose original absence type'], ...Object.entries(TYPE).filter(([k]) => k !== 'legacy')], ''), why = input('classify_reason', '', { maxlength: 300, placeholder: 'Why this historical record is being reconciled' }), msg = message();
        const action = async (status) => { try {
            await api('PATCH', `/api/rota/leave/requests/${t.id}`, { status, ifVersion: t.version, kind: classification.value || undefined, coveredByOpening: covered.input.checked });
            closeSheets();
            toast(`Absence ${status}.`);
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } };
        openSheet('Review absence', el('div', { class: 'sbody' }, el('h3', { text: t.name || TYPE[t.kind] }), note(`${TYPE[t.kind]} · ${span(t.from, t.to)}${t.fromTime ? ` · ${t.fromTime}–${t.toTime}` : ''} · ${STAT[t.status]}`), t.days.length ? note(chargeText(t.days)) : null, t.reason ? note(t.reason) : null, t.coveredByOpening ? note('Historical days are included in the opening used balance. If you cancel this record, reconcile the opening used figure separately; it cannot be refunded twice automatically.') : null, ...(t.balances || []).map(b => note(`${b.from} leave year: ${amount(b.available)} days available after pending requests.`)), (t.shiftConflicts || []).length ? el('div', { class: 'leave-notice' }, el('b', { text: 'Assigned shifts need review' }), ...t.shiftConflicts.map(s => note(`${shortM(s.day)} · ${SITES[s.site] || s.site} · ${s.start}–${s.end}`)), note('Approval marks this absence on the rota. Existing assignments are retained for you to resolve.')) : null, t.kind === 'legacy' ? field('absence_classification', 'Classify existing time off', classification, true) : null, t.kind === 'legacy' ? covered.node : null, t.kind === 'legacy' && t.status === 'approved' ? field('classify_reason', 'Reason for reconciliation', why, true) : null, msg, el('div', { class: 'sfoot' }, t.status === 'requested' ? ghost('Decline', () => action('declined')) : null, t.status === 'requested' ? btn('Approve', () => action('approved')) : null, t.kind === 'legacy' && t.status === 'approved' ? btn('Reconcile record', async () => { try {
            await api('PATCH', `/api/rota/leave/requests/${t.id}/classify`, { kind: classification.value, changeReason: why.value, coveredByOpening: covered.input.checked, ifVersion: t.version });
            closeSheets();
            render();
        }
        catch (e) {
            msg.textContent = errorText(e);
        } }) : null, t.status === 'approved' ? ghost('Cancel absence', () => action('cancelled')) : null)), { left: cancelLink() });
    }
    return { dashboard, admin, request, clear, review };
};
