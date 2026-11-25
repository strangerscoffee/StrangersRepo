// One invoice number series shared with QuickBooks (the owner's request, 25 Nov 2026). QuickBooks suggests the number
// after the last one entered on any invoice, sales receipt or credit note (they share one list), so the website's own
// STR series kept being followed by invoices typed in by hand, which then took the website's next number. With
// "Use QuickBooks invoice numbers" on, each invoice the website issues first asks QuickBooks for the highest plain
// number in use and takes the next one, so everyone draws from one series and QuickBooks's suggestion stays right.
// If QuickBooks can't be reached, no number is chosen: automatic invoices wait and are tried again.
import { ApiError, type Env } from '../http';
import { connection, resourceReader } from './connection';
import type { Environment } from './preview';
import { settings } from './settings';

const PLAIN = /^\d{1,12}$/;
/** Sales forms that share QuickBooks's custom transaction number list. */
export const SHARED_FORMS = ['Invoice', 'SalesReceipt', 'CreditMemo'] as const;
/** How many of each, newest first, are looked at: numbers only go up, so the highest is among the latest. */
const RECENT = 100;

export class NumberUnavailable extends ApiError {
  constructor(message: string) { super(503, 'invoice_number_unavailable', message); }
}

export interface NumberingCompany {
  environment: Environment;
  realm: string;
  generation: string;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_/# ';

/** The highest number issued here, plain or by the digits after its prefix. */
export async function highestLocal(env: Env) {
  // Prefixed numbers count by their digits (STR010248 as 10248), so the shared series never repeats a number
  // the website has already used under its prefix, and no "10248" sits beside an older "STR010248".
  const row = await env.DB.prepare(`SELECT MAX(CAST(digits AS INTEGER)) AS n FROM (SELECT ltrim(invoice_number, '${LETTERS}') AS digits FROM wholesale_invoices) WHERE digits<>'' AND digits NOT GLOB '*[^0-9]*'`).first<{ n: number | null }>();
  return row?.n || 0;
}

/** The highest plain number on QuickBooks's recent invoices, sales receipts and credit notes, in the active company. */
export async function highestInQuickBooks(req: Request, env: Env, expected?: NumberingCompany) {
  const state = await settings(env), mode = state.active_environment, company = await connection(env, mode);
  const companyChanged = () => new NumberUnavailable('Switch back to the approved QuickBooks company to number the invoices in this batch.');
  if (expected && (expected.environment !== mode || expected.realm !== company.realm_id || expected.generation !== company.generation)) throw companyChanged();
  if (company.status !== 'connected') throw new NumberUnavailable("QuickBooks isn't connected, so the next invoice number can't be checked. Connect QuickBooks, or switch off \"Use QuickBooks invoice numbers\".");
  let highest = 0;
  try {
    const { read, check } = await resourceReader(req, env, company, mode);
    for (const form of SHARED_FORMS) {
      const data = await read('/query?minorversion=75&query=' + encodeURIComponent(`SELECT * FROM ${form} ORDERBY MetaData.CreateTime DESC MAXRESULTS ${RECENT}`));
      const rows = data?.QueryResponse?.[form];
      for (const row of Array.isArray(rows) ? rows : []) if (PLAIN.test(String(row?.DocNumber || ''))) highest = Math.max(highest, Number(row.DocNumber));
    }
    if (expected) {
      await check();
      if ((await settings(env)).active_environment !== mode) throw companyChanged();
    }
  } catch (error) {
    if (error instanceof NumberUnavailable) throw error;
    throw new NumberUnavailable("QuickBooks couldn't be reached to choose the next invoice number. It will be tried again." + (error instanceof Error && /Intuit ref/.test(error.message) ? ' ' + error.message : ''));
  }
  return highest;
}

/** The next number in the shared series: one more than the highest in QuickBooks or issued here, whichever is higher. */
export async function nextSharedNumber(req: Request, env: Env, expected?: NumberingCompany) {
  const [quickbooks, local] = await Promise.all([highestInQuickBooks(req, env, expected), highestLocal(env)]);
  const highest = Math.max(quickbooks, local);
  if (!highest) throw new NumberUnavailable('QuickBooks has no plain invoice numbers yet to follow on from. Switch off "Use QuickBooks invoice numbers", or enter one invoice in QuickBooks first.');
  return String(highest + 1);
}
