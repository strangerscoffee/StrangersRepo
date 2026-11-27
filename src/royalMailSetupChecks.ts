import { audit } from "./audit";
import { ApiError, invalid, json, readJson, type Env } from "./http";
import { ukDay } from "./insightsMath";
import { loadRoyalMailConnections, readRoyalMailPolicy } from "./royalMailAppSettings";
import { royalMailPostcode } from "./royalMailDestination";
import { runRoyalMailProviderChecks } from "./royalMailProviderChecks";
import { object, version } from "./wholesaleStore";

type Connections = Awaited<ReturnType<typeof loadRoyalMailConnections>>;
type Policy = Awaited<ReturnType<typeof readRoyalMailPolicy>>;
type Evidence = Record<string, string | number>;
interface Checklist {
  version: number;
  scope: string;
  serviceCode: string | null;
  serviceRegisterCode: string | null;
  automated: {
    checkedAt: number;
    checkedBy: string;
    checks: Awaited<ReturnType<typeof runRoyalMailProviderChecks>>;
  } | null;
  manual: Record<string, { confirmedAt: number; confirmedBy: string; evidence: Evidence }>;
}
interface StoredChecklist {
  scope_key: string;
  version: number;
  scope: string | null;
  automated: string | null;
  manual: string;
}

const manualLabels = new Map([
  ["returnAddress", "Printed return address and trading name"],
  ["printer", "Label printer and barcode"],
  ["collection", "Carrier collection arrangements"],
  ["manifest", "End-of-day manifest and proof of collection"],
  ["register", "Contract service register"],
  ["parcelLimits", "Contract parcel limits"],
]);

function conflict() {
  return new ApiError(409, "conflict", "Royal Mail setup or its checks changed. Reload the checklist before continuing.");
}

// Worker-bound credentials can change independently of the settings record. A database-specific
// key keeps the browser-visible scope opaque even when a setting has few possible values.
async function connectionScope(scopeKey: string, policy: Policy, connections: Connections) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(scopeKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fields = [policy.booking_config, policy.tracking_config, connections.booking, connections.tracking, connections.credentialSetup];
  const hash = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(fields)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid("Send only the requested checklist fields.");
}

const ownerRoles = ["dispatchLead", "shiftSupervisor", "dutyManager", "accountAdmin"];
const sites = ["roastery", "warehouse", "pottergate", "allSaintsGreen", "agreedDropOff", "otherAgreedSite"];

function choice(value: unknown, options: string[], label: string): string {
  if (typeof value !== "string" || !options.includes(value)) throw invalid(`Choose ${label}.`);
  return value;
}

function positiveNumber(value: unknown, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw invalid(`Enter ${label} as a whole number from 1 to ${max}.`);
  }
  return value;
}

// Confirmation records hold closed choices, numeric limits and a local cutoff time. Addresses,
// label files, customer identifiers, and free-form credentials do not belong in the checklist.
function manualEvidence(id: string, raw: unknown, connections: Connections): Evidence {
  const entry = raw === undefined ? {} : object(raw);
  switch (id) {
    case "returnAddress":
      fields(entry, []);
      return {};
    case "printer":
      fields(entry, ["format"]);
      return { format: choice(entry.format, ["thermal4x6", "a4", "other"], "the tested label format") };
    case "collection": {
      fields(entry, ["carrier", "site", "cutoff", "owner"]);
      const carrier = choice(entry.carrier, ["royalMail", "parcelforce", "both"], "the collecting carrier");
      const site = choice(entry.site, sites, "the agreed handover site");
      if (typeof entry.cutoff !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry.cutoff)) throw invalid("Enter the local handover cutoff in HH:MM.");
      return { carrier, site, cutoff: entry.cutoff, owner: choice(entry.owner, ownerRoles, "the role responsible for collection") };
    }
    case "manifest":
      fields(entry, ["owner", "proof", "site"]);
      return {
        site: choice(entry.site, sites, "the manifest handover site"),
        owner: choice(entry.owner, ownerRoles, "the role responsible for the manifest"),
        proof: choice(entry.proof, ["signedManifest", "collectionReceipt", "acceptanceScan"], "how proof of handover is kept"),
      };
    case "register": {
      fields(entry, ["requirement"]);
      if (!connections.booking.serviceCode) throw invalid("Save a valid booking service before confirming its register.");
      const requirement = choice(entry.requirement, ["configured", "notRequired"], "the register requirement in your agreement");
      if ((requirement === "configured") !== Boolean(connections.booking.serviceRegisterCode)) {
        throw invalid("Update the booking service register to match the agreement before confirming.");
      }
      return { requirement };
    }
    case "parcelLimits": {
      fields(entry, ["maxWeightGrams", "maxLengthCm", "maxLengthPlusGirthCm", "maxVolumeLitres"]);
      if (!connections.booking.serviceCode) throw invalid("Save a valid booking service before confirming its contract parcel limits.");
      const express24 = connections.booking.serviceCode.toUpperCase() === "NDB";
      const maxWeightGrams = positiveNumber(entry.maxWeightGrams, 30000, "the supported maximum weight in grams");
      const maxLengthCm = positiveNumber(entry.maxLengthCm, 1000, "the maximum length in centimetres");
      const limits: Evidence = { maxWeightGrams, maxLengthCm };
      if (entry.maxLengthPlusGirthCm !== undefined) {
        const combined = positiveNumber(entry.maxLengthPlusGirthCm, 2000, "the maximum length plus girth in centimetres");
        if (combined < maxLengthCm) throw invalid("The length plus girth limit must be at least the length limit.");
        limits.maxLengthPlusGirthCm = combined;
      }
      if (entry.maxVolumeLitres !== undefined || express24) {
        limits.maxVolumeLitres = positiveNumber(entry.maxVolumeLitres, 2000, "the maximum volume in litres");
      }
      return limits;
    }
    default:
      throw invalid("Choose a setup check.");
  }
}

function checklistView(checklist: Checklist) {
  if (checklist.manual.manifest && ukDay(checklist.manual.manifest.confirmedAt) !== ukDay(Date.now())) delete checklist.manual.manifest;
  return json(checklist);
}

export async function handleRoyalMailSetupChecks(req: Request, env: Env, actor: string) {
  if (!["GET", "PUT", "POST"].includes(req.method)) throw new ApiError(405, "method_not_allowed", "Use GET, PUT or POST for setup checks.");
  const [stored, policy] = await Promise.all([
    env.DB.prepare("SELECT scope_key, version, scope, automated, manual FROM wholesale_royal_mail_setup_checks WHERE id = 1").first<StoredChecklist>(),
    readRoyalMailPolicy(env),
  ]);
  if (!stored) throw new ApiError(503, "setup_checks_unavailable", "Royal Mail setup checks are unavailable.");
  const connections = await loadRoyalMailConnections(env, policy);
  const scope = await connectionScope(stored.scope_key, policy, connections);
  const current = stored.scope === scope;
  const checklist: Checklist = { version: stored.version, scope,
    serviceCode: connections.booking.serviceCode,
    serviceRegisterCode: connections.booking.serviceCode ? connections.booking.serviceRegisterCode ?? null : null,
    automated: current && stored.automated ? JSON.parse(stored.automated) : null,
    manual: current ? JSON.parse(stored.manual) : {},
  };
  if (req.method === "GET") return checklistView(checklist);
  const body = object(await readJson(req, 2048));
  if (version(body.ifVersion) !== checklist.version || body.scope !== scope) throw conflict();
  let event: string;
  if (req.method === "POST") {
    fields(body, ["ifVersion", "scope", "sample"]);
    let sample = null;
    if (body.sample != null) {
      const value = object(body.sample);
      fields(value, ["postcode", "weightGrams"]);
      sample = { postcode: royalMailPostcode(value.postcode), weightGrams: positiveNumber(value.weightGrams, 30000, "the packed parcel weight in grams") };
    }
    const checks = await runRoyalMailProviderChecks(env, connections, sample);
    checklist.automated = { checkedAt: Date.now(), checkedBy: actor, checks };
    event = "Ran the read-only Royal Mail setup checks.";
  } else {
    const fieldsAllowed = ["ifVersion", "scope", "id", "confirmed", "evidence"];
    if (body.id === "manifest") fieldsAllowed.push("manifestDay");
    fields(body, fieldsAllowed);
    const confirmedAt = Date.now();
    if (body.id === "manifest" && body.manifestDay !== ukDay(confirmedAt)) {
      throw new ApiError(409, "conflict", "The UK handover date changed. Reload the checklist and review today's manifest.");
    }
    const label = manualLabels.get(body.id);
    if (!label || typeof body.confirmed !== "boolean") throw invalid("Choose a setup check and its confirmation state.");
    if (body.confirmed) {
      const evidence = manualEvidence(body.id, body.evidence, connections);
      checklist.manual[body.id] = { confirmedAt, confirmedBy: actor, evidence };
    } else {
      if (body.evidence !== undefined) fields(object(body.evidence), []);
      delete checklist.manual[body.id];
    }
    event = label + (body.confirmed ? " confirmed in Royal Mail setup." : " confirmation cleared in Royal Mail setup.");
  }

  // A newer check or credential edit wins over slow provider responses and stale forms.
  const update = await env.DB.prepare(`UPDATE wholesale_royal_mail_setup_checks SET version = version + 1,
    scope = ?, automated = ?, manual = ? WHERE id = 1 AND version = ?
    AND EXISTS (SELECT 1 FROM wholesale_royal_mail_settings WHERE id = 1 AND version = ?)`)
    .bind(scope, checklist.automated ? JSON.stringify(checklist.automated) : null, JSON.stringify(checklist.manual), checklist.version, policy.version).run();
  if (!update.meta.changes) throw conflict();
  checklist.version++;
  await audit(env, "wholesale_royal_mail", actor, event);
  return checklistView(checklist);
}
