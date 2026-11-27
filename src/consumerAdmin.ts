import { ApiError, Env, json, readJson, readBytes } from "./http";
import { BRANDED_RETAIL_ORIGIN } from "./brandedRetail";
import { retailServiceRequest } from "./retailService";

const CONTROL_PATH = "/api/control/consumer";
const MAX_OVERVIEW_BYTES = 2 * 1024 * 1024;
const ORDER_STATES = new Set(["placed", "preparing", "ready", "dispatched", "completed", "cancelled"]);

function offline(detail: string) {
  return json({
    connected: false,
    previewUrl: BRANDED_RETAIL_ORIGIN + "/",
    readiness: [{ label: "Consumer preview connection", state: "blocked", detail }],
    orders: [],
    customers: [],
    products: [],
    settings: { acceptOrders: false },
  });
}

function queueSearch(req: Request): string {
  const supplied = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  const search = (supplied.get("q") || "").trim();
  const status = supplied.get("status") || "all";
  const cursor = supplied.get("cursor") || "";
  if (search.length > 120 || /[\u0000-\u001f\u007f]/.test(search) || cursor.length > 360 ||
      (status !== "all" && status !== "to-pack" && !ORDER_STATES.has(status))) {
    throw new ApiError(400, "invalid_argument", "Check the order search and try again.");
  }
  if (search) query.set("q", search);
  query.set("status", status);
  if (cursor) query.set("cursor", cursor);
  return "?" + query.toString();
}

function supportSearch(req: Request): string {
  const params = new URL(req.url).searchParams;
  const query = new URLSearchParams();
  const search = (params.get("q") || "").trim();
  const cursor = params.get("cursor");
  if (search.length > 120 || /[\u0000-\u001f\u007f]/.test(search) ||
      (cursor !== null && (cursor.length > 160 || !/^[A-Za-z0-9_-]+$/.test(cursor)))) {
    throw new ApiError(400, "invalid_argument", "Check the support search and try again.");
  }
  if (search) query.set("q", search);
  if (cursor) query.set("cursor", cursor);
  return query.size ? "?" + query : "";
}

function orderUpdate(input: Record<string, unknown>): string {
  const { ifVersion, status, packedLines, tracking } = input;
  const legacy = ifVersion === undefined && Object.keys(input).length === 1 && typeof status === "string";
  if ((!legacy && !(typeof ifVersion === "number" && Number.isSafeInteger(ifVersion) && ifVersion >= 0)) ||
      (status !== undefined && !(typeof status === "string" && ORDER_STATES.has(status))) ||
      (packedLines !== undefined && (!Array.isArray(packedLines) || packedLines.length > 250 ||
        packedLines.some(line => !Number.isInteger(line) || line < 0 || line >= 250))) ||
      (status === undefined && packedLines === undefined && tracking === undefined)) {
    throw new ApiError(400, "invalid_argument", "Check the fulfilment change and try again.");
  }
  let shipment;
  if (tracking !== undefined) {
    const { carrier, number } = (tracking ?? {}) as { carrier?: unknown; number?: unknown };
    if (carrier !== "royal-mail" || typeof number !== "string" || !/^[A-Z0-9 -]{5,35}$/i.test(number.trim())) {
      throw new ApiError(400, "invalid_tracking", "Enter a Royal Mail tracking number.");
    }
    shipment = { carrier, number: number.trim() };
  }
  return JSON.stringify({ ifVersion, status, packedLines, tracking: shipment });
}

/** Signs requests that manage the separate test storefront. */
export async function handleConsumerAdmin(req: Request, env: Env, route: string): Promise<Response> {
  const queue = route === "orders";
  const reading = (route === "" || queue || route === "support") && req.method === "GET";
  const order = /^orders\/(SC-[A-F0-9]{8})$/.exec(route);
  const product = /^products\/([a-z0-9][a-z0-9-]{0,99})$/.exec(route);
  const updatingSettings = route === "settings" && req.method === "PUT";
  const support = /^support\/HELP-[A-F0-9]{8}$/.test(route);
  const patching = (order || product || support) && req.method === "PATCH";
  if (!reading && !updatingSettings && !patching) {
    throw new ApiError(404, "not_found", "Consumer preview action not found.");
  }

  let body: string | undefined;
  if (!reading) {
    const input = await readJson(req, order ? 8192 : 2048);
    if (order && input && typeof input === "object" && !Array.isArray(input)) {
      body = orderUpdate(input);
    } else if (support && typeof input?.resolved === "boolean") {
      body = JSON.stringify({ resolved: input.resolved });
    } else if (product && typeof input?.available === "boolean") {
      body = JSON.stringify({ available: input.available });
    } else if (updatingSettings && typeof input?.acceptOrders === "boolean") {
      body = JSON.stringify({ acceptOrders: input.acceptOrders });
    } else {
      throw new ApiError(400, "invalid_argument", "Check the Consumer preview change and try again.");
    }
  }

  const query = queue ? queueSearch(req) : route === "support" ? supportSearch(req) : "";
  const destination = CONTROL_PATH + (route ? "/" + route : "") + query;
  try {
    const response = await retailServiceRequest(env, destination, {
      method: req.method, body,
    });
    if (response.ok || [400, 404, 409, 422].includes(response.status)) {
      const bytes = await readBytes(response, MAX_OVERVIEW_BYTES, "The preview response was too large.");
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (response.ok && route === "") result.previewUrl = BRANDED_RETAIL_ORIGIN + "/";
      if (response.ok && route === "support") result.supportGateway = 1;
      return json(result, response.status);
    }
    await response.body?.cancel();
  } catch {
    // A preview outage must not expose credentials or break the staff dashboard.
  }

  if (reading && route === "") return offline("The Consumer preview could not be reached. Check the connection and try again.");
  throw new ApiError(503, "consumer_unavailable", "The Consumer preview could not complete the request. Refresh and try again.");
}
