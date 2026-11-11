import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startServer, SETUP_CODE } from "./harness.mjs";

let srv, ADMIN, BUYER, coffee, originalOrder, originalRequest;
const PNG = await readFile(new URL("../public/icon-192.png", import.meta.url));
const cookieOf = (response) => (response.headers.getSetCookie().find((value) => /^sf(?:bb|_wholesale)_session=[\w-]/.test(value)) || "").split(";")[0];
async function call(method, path, body, cookie = ADMIN) {
  const response = await fetch(srv.base + path, { method, redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, body: data, cookie: cookieOf(response), headers: response.headers, text };
}
async function upload(current, { cookie = ADMIN, type = "image/png", bytes = PNG, expected = current.version } = {}) {
  const response = await fetch(`${srv.base}/api/admin/wholesale/catalogue/${current.id}/images?ifVersion=${expected}`, { method: "POST", headers: { "content-type": type, "x-file-name": "coffee.png", ...(cookie ? { cookie } : {}) }, body: bytes });
  return { status: response.status, body: await response.json() };
}
async function requestFor(product, extra = {}) {
  const profile = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body.customer;
  return { requestId: crypto.randomUUID(), lines: [{ productId: product.id, pack: "kilo", grind: "beans", quantity: 2, price: product.prices.kilo }], delivery: "Roastery collection", customerVersion: profile.version, ...extra };
}
async function editProduct(values = {}) {
  const result = await call("PUT", `/api/admin/wholesale/catalogue/${coffee.id}`, { ifVersion: coffee.version, prices: coffee.prices, active: coffee.active, inStock: coffee.inStock, ...values });
  assert.equal(result.status, 200, result.text); coffee = result.body.product;
  return coffee;
}
before(async () => {
  srv = await startServer({ writeLimit: 2000 });
  ADMIN = (await call("POST", "/api/auth/setup", { name: "Catalogue Owner", username: "owner", password: "owner-password", code: SETUP_CODE }, null)).cookie;
  const customer = (await call("POST", "/api/admin/wholesale/customers", { business: "Catalogue Cafe", contact: "Buyer", email: "buyer@example.com", status: "Active", paymentTerms: "net-30", paymentNote: "Use your order reference when paying.", note: "Private credit review" })).body.customer;
  const account = (await call("POST", `/api/admin/wholesale/customers/${customer.id}/account`, { username: "catalogue.buyer" })).body;
  BUYER = (await call("POST", "/api/wholesale/auth/change-password", { username: account.account.username, password: account.temporaryPassword, newPassword: "catalogue-buyer-password" }, null)).cookie;
  assert.ok(BUYER);
});
after(async () => { await srv?.stop(); });

test('order preparation metadata is server-snapshotted, retained after catalogue edits and protected from client overrides', async () => {
  const option={id:'grind-'+crypto.randomUUID(),label:'Evening filter',hint:'Paper filter, medium grind',enabled:true};
  let product=(await call('POST','/api/admin/wholesale/catalogue',{title:'Evening Coffee',name:'Evening Coffee',origin:'Colombia',process:'Washed',notes:'Chocolate',badge:'',categories:['decaf'],prices:{quarter:900,kilo:3000},active:true,inStock:true,grindOptions:[option]})).body.product;
  const request=await requestFor(product,{lines:[{productId:product.id,pack:'kilo',grind:option.id,quantity:2,price:product.prices.kilo,decaf:false,grindHint:'Client replacement'}]});
  const created=await call('POST','/api/wholesale/orders',request,BUYER);
  assert.equal(created.status,201,created.text);
  assert.equal(created.body.order.lines[0].decaf,true);
  assert.equal(created.body.order.lines[0].grindHint,option.hint);
  const changed=await call('PUT','/api/admin/wholesale/catalogue/'+product.id,{ifVersion:product.version,prices:product.prices,active:true,categories:['single-origin'],grindOptions:[{...option,hint:'Changed later'}]});
  assert.equal(changed.status,200,changed.text);
  const read=await call('GET','/api/wholesale/orders/'+created.body.order.id,undefined,BUYER);
  assert.equal(read.body.order.lines[0].decaf,true);assert.equal(read.body.order.lines[0].grindHint,option.hint);
  const retried=await call('POST','/api/wholesale/orders',request,BUYER);
  assert.equal(retried.status,200,retried.text);assert.deepEqual(retried.body.order.lines,created.body.order.lines);
});

test("catalogue: admin-created coffees can be ordered, edited and versioned without rewriting old prices or descriptions", async () => {
  const created = await call("POST", "/api/admin/wholesale/catalogue", { title: "New Norwich Coffee", name: "Norwich Coffee", origin: "Brazil", process: "Natural", notes: "Chocolate and orange", badge: "Seasonal", categories: ["single-origin"], prices: { quarter: 1200, half: 2300, kilo: 4200 }, active: true, inStock: true });
  assert.equal(created.status, 201, created.text); coffee = created.body.product;
  assert.match(coffee.id, /^coffee-[a-f0-9-]{36}$/); assert.deepEqual(coffee.imageUrls, []);
  const loaded = (await call("GET", "/api/wholesale/catalogue", undefined, BUYER)).body.products.find((row) => row.id === coffee.id);
  assert.equal(loaded.name, coffee.name); assert.equal(loaded.inStock, true);
  originalRequest = await requestFor(coffee);
  const placed = await call("POST", "/api/wholesale/orders", originalRequest, BUYER);
  assert.equal(placed.status, 201, placed.text); originalOrder = placed.body.order;
  assert.equal(originalOrder.lines[0].title, "New Norwich Coffee"); assert.equal(originalOrder.pence, 8400);
  const stale = coffee.version;
  await editProduct({ title: "Renamed Coffee", name: "Renamed", prices: { quarter: 1300, half: 2400, kilo: 4400 }, categories: ["blend"] });
  assert.equal((await call("PUT", `/api/admin/wholesale/catalogue/${coffee.id}`, { ifVersion: stale, prices: coffee.prices, active: true })).status, 409);
  const old = (await call("GET", `/api/wholesale/orders/${originalOrder.id}`, undefined, BUYER)).body.order;
  assert.equal(old.lines[0].title, "New Norwich Coffee"); assert.equal(old.lines[0].price, 4200);
  const staleQuote = await call("POST", "/api/wholesale/orders", { ...originalRequest, requestId: crypto.randomUUID() }, BUYER);
  assert.equal(staleQuote.status, 409);
  for (const invalid of [{ prices: { quarter: 0, half: 2000, kilo: 4000 } }, { categories: ["unknown"] }, { inStock: "yes" }]) assert.equal((await call("PUT", `/api/admin/wholesale/catalogue/${coffee.id}`, { ifVersion: coffee.version, prices: coffee.prices, active: true, ...invalid })).status, 400);
});

test("catalogue stock: out-of-stock and hidden coffees cannot create orders, but exact prior retries still work", async () => {
  await editProduct({ inStock: false });
  let blocked = await call("POST", "/api/wholesale/orders", await requestFor(coffee), BUYER);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, "out_of_stock");
  const listed = (await call("GET", "/api/wholesale/catalogue", undefined, BUYER)).body.products.find((row) => row.id === coffee.id);
  assert.equal(listed.active, true); assert.equal(listed.inStock, false);
  const retried = await call("POST", "/api/wholesale/orders", originalRequest, BUYER);
  assert.equal(retried.status, 200); assert.equal(retried.body.order.id, originalOrder.id);
  await editProduct({ active: false, inStock: true });
  blocked = await call("POST", "/api/wholesale/orders", await requestFor(coffee), BUYER);
  assert.equal(blocked.status, 409);
  await editProduct({ active: true });
});

test("catalogue photos: admin upload, private serving, concurrent edits and removal keep references consistent", async () => {
  assert.equal((await upload(coffee, { cookie: BUYER })).status, 401);
  const first = await upload(coffee);
  assert.equal(first.status, 201, JSON.stringify(first.body)); coffee = first.body.product;
  assert.equal(coffee.images.length, 1); assert.match(coffee.imageUrls[0], /^\/api\/admin\/wholesale\/images\//);
  const customerProduct = (await call("GET", "/api/wholesale/catalogue", undefined, BUYER)).body.products.find((row) => row.id === coffee.id);
  const url = customerProduct.imageUrls[0];
  assert.match(url, /^\/api\/wholesale\/images\//);
  const image = await fetch(srv.base + url, { headers: { cookie: BUYER } });
  assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/png"); assert.match(image.headers.get("cache-control"), /private/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.equal((await fetch(srv.base + url)).status, 401);
  const raced = await Promise.all([upload(coffee), upload(coffee)]);
  assert.deepEqual(raced.map((row) => row.status).sort(), [201, 409]);
  coffee = raced.find((row) => row.status === 201).body.product;
  assert.equal(coffee.images.length, 2);
  const remove = coffee.images[0];
  const removed = await call("PATCH", `/api/admin/wholesale/catalogue/${coffee.id}/images`, { ifVersion: coffee.version, remove });
  assert.equal(removed.status, 200, removed.text); coffee = removed.body.product;
  assert.equal(coffee.images.includes(remove), false);
  assert.equal((await fetch(srv.base + url, { headers: { cookie: BUYER } })).status, 404);
});

test("catalogue photos: types, size, gallery limits and restoring the original photo are validated", async () => {
  assert.equal((await upload(coffee, { type: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') })).status, 415);
  const mislabeled = await upload(coffee, { type: "image/jpeg" });
  assert.equal(mislabeled.status, 201, "the actual raster bytes decide the safe serving type");
  coffee = mislabeled.body.product;
  const corrected = await fetch(srv.base + coffee.imageUrls.at(-1), { headers: { cookie: ADMIN } });
  assert.equal(corrected.headers.get("content-type"), "image/png");
  assert.equal((await upload(coffee, { bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await upload(coffee, { expected: coffee.version - 1 })).status, 409);
  while (coffee.images.length < 6) {
    const result = await upload(coffee); assert.equal(result.status, 201); coffee = result.body.product;
  }
  assert.equal((await upload(coffee)).status, 400);
  let brazil = (await call("GET", "/api/admin/wholesale")).body.products.find((row) => row.id === "brazil");
  const removed = await call("PATCH", "/api/admin/wholesale/catalogue/brazil/images", { ifVersion: brazil.version, remove: "source:brazil.webp" });
  assert.equal(removed.status, 200); brazil = removed.body.product; assert.deepEqual(brazil.imageUrls, []);
  const bad = await call("PATCH", "/api/admin/wholesale/catalogue/brazil/images", { ifVersion: brazil.version, restore: true, remove: coffee.images[0] });
  assert.equal(bad.status, 400, "restore cannot also delete another photo");
  const restored = await call("PATCH", "/api/admin/wholesale/catalogue/brazil/images", { ifVersion: brazil.version, restore: true });
  assert.equal(restored.status, 200); assert.deepEqual(restored.body.product.imageUrls, ["/wholesale-preview/images/brazil.webp"]);
});

test("payment terms: only admins set terms; checkout checks the reviewed version and keeps immutable order terms", async () => {
  let profile = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body.customer;
  assert.equal(profile.paymentTerms.id, "net-30");
  const forged = await call("PUT", "/api/wholesale/account", { ...profile, ifVersion: profile.version, paymentTerms: "net-60", paymentNote: "Forged instructions" }, BUYER);
  assert.equal(forged.status, 200); profile = forged.body.customer;
  assert.equal(profile.paymentTerms.id, "net-30"); assert.equal(profile.paymentTerms.note, "Use your order reference when paying.");
  const request = await requestFor(coffee);
  const { customerVersion, ...legacyRequest } = request;
  const legacy = await call("POST", "/api/wholesale/orders", legacyRequest, BUYER);
  assert.equal(legacy.status, 409); assert.match(legacy.body.message, /Reload the page/);
  const placed = await call("POST", "/api/wholesale/orders", request, BUYER);
  assert.equal(placed.status, 201, placed.text); assert.equal(placed.body.order.paymentTerms.id, "net-30");
  let customer = (await call("GET", "/api/admin/wholesale")).body.customers.find((row) => row.id === profile.id);
  const updated = await call("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...customer, ifVersion: customer.version, paymentTerms: "net-7", paymentNote: "Quote the invoice number." });
  assert.equal(updated.status, 200, updated.text); customer = updated.body.customer;
  const stale = await call("POST", "/api/wholesale/orders", { ...request, requestId: crypto.randomUUID() }, BUYER);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "account_changed");
  const old = (await call("GET", `/api/wholesale/orders/${placed.body.order.id}`, undefined, BUYER)).body.order;
  assert.equal(old.paymentTerms.id, "net-30"); assert.equal(old.paymentTerms.note, "Use your order reference when paying.");
  assert.equal((await call("POST", "/api/wholesale/orders", request, BUYER)).body.order.id, old.id);
  const next = await call("POST", "/api/wholesale/orders", await requestFor(coffee), BUYER);
  assert.equal(next.status, 201); assert.equal(next.body.order.paymentTerms.id, "net-7");
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...customer, ifVersion: customer.version, paymentTerms: "unlimited-credit" })).status, 400);
  assert.equal((await call("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...customer, ifVersion: customer.version, paymentTerms: "custom", paymentNote: "" })).status, 400);
  const custom = await call("PUT", `/api/admin/wholesale/customers/${customer.id}`, { ...customer, ifVersion: customer.version, paymentTerms: "custom", paymentNote: "Pay on our agreed monthly invoice run." });
  assert.equal(custom.status, 200);
  const own = (await call("GET", "/api/wholesale/session", undefined, BUYER)).body.customer;
  assert.equal(own.paymentTerms.id, "custom"); assert.equal(own.paymentTerms.note, "Pay on our agreed monthly invoice run.");
});

test('grind options: legacy defaults, admin-only editing, validation and concurrent versions', async () => {
  const original = (await call('GET','/api/admin/wholesale')).body.products.find(p=>p.id==='brazil');
  assert.deepEqual(original.grindOptions.map(g=>g.id), ['beans','espresso','filter','cafetiere']);
  assert.deepEqual(original.grindOptions.map(g=>g.label), ['Beans','Fine','Medium','Coarse']);
  assert.ok(original.grindOptions.every(g=>g.hint), 'each grind says what it is for');
  const body = { ifVersion: original.version, prices: original.prices, active:true, grindOptions: original.grindOptions };
  for (const cookie of [null, BUYER]) assert.ok([401,403].includes((await call('PUT','/api/admin/wholesale/catalogue/brazil',body,cookie)).status));
  for (const grindOptions of [null,[],[{id:'__proto__',label:'Bad',enabled:true}],[{id:'beans',label:'',enabled:true}],[{id:'beans',label:'x'.repeat(61),enabled:true}],original.grindOptions.map(g=>({...g,enabled:false})),[original.grindOptions[0],original.grindOptions[0]],[{id:'beans',label:'Same',enabled:true},{id:'espresso',label:'same',enabled:true}]]) assert.equal((await call('PUT','/api/admin/wholesale/catalogue/brazil',{...body,grindOptions})).status,400);
  const updated = await call('PUT','/api/admin/wholesale/catalogue/brazil',body); assert.equal(updated.status,200);
  assert.equal((await call('PUT','/api/admin/wholesale/catalogue/brazil',body)).status,409);
});
test('grind options: custom choices are server validated, renamed options retire IDs, exact retries retain immutable labels', async () => {
  const custom = {id:'grind-'+crypto.randomUUID(),label:'Turkish / Extra fine',enabled:true};
  let product = (await call('POST','/api/admin/wholesale/catalogue',{title:'Grind Test',name:'Grind Test',categories:['blend'],prices:{quarter:1100,half:2200,kilo:4000},active:true,grindOptions:[custom]})).body.product;
  const request = await requestFor(product); request.lines[0].grind = custom.id; request.lines[0].grindLabel = 'FORGED';
  const saved = await call('POST','/api/wholesale/orders',request,BUYER); assert.equal(saved.status,201,saved.text); assert.equal(saved.body.order.lines[0].grindLabel,custom.label);
  const refused = await call('POST','/api/wholesale/orders',{...request,requestId:crypto.randomUUID(),lines:[{...request.lines[0],grind:'beans'}]},BUYER); assert.equal(refused.status,409);
  product = (await call('PUT',`/api/admin/wholesale/catalogue/${product.id}`,{...product,ifVersion:product.version,grindOptions:[{...custom,label:'Turkish fine'}]})).body.product;
  assert.notEqual(product.grindOptions[0].id,custom.id,'renaming cannot silently reinterpret an old reviewed basket');
  assert.equal((await call('POST','/api/wholesale/orders',{...request,requestId:crypto.randomUUID()},BUYER)).status,409);
  const retry = await call('POST','/api/wholesale/orders',request,BUYER); assert.equal(retry.status,200); assert.equal(retry.body.order.lines[0].grindLabel,custom.label);
  const fresh = await requestFor(product); fresh.lines[0].grind=product.grindOptions[0].id;
  assert.equal((await call('POST','/api/wholesale/orders',fresh,BUYER)).body.order.lines[0].grindLabel,'Turkish fine');
});

test("packaging colours: admins set one or two colours or go back to the automatic one; other edits keep them", async () => {
  const list = async () => (await call("GET", "/api/admin/wholesale")).body;
  const products = (await list()).products;
  const brazil = products.find(p => p.id === "brazil");
  assert.equal(brazil.colours, undefined, "built-in coffees use the packaging colours from the page, not saved ones");
  const put = (product, values) => call("PUT", `/api/admin/wholesale/catalogue/${product.id}`, { ifVersion: product.version, prices: product.prices, active: product.active, inStock: product.inStock, ...values });
  let saved = await put(brazil, { colours: ["#e35d4e", "#2a7162"] });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual([saved.body.product.colours, saved.body.product.colourStyle], [["#E35D4E", "#2A7162"], "striped"]);
  saved = await put(saved.body.product, { notes: "Edited notes" });
  assert.deepEqual(saved.body.product.colours, ["#E35D4E", "#2A7162"], "an edit without colours keeps them");
  saved = await put(saved.body.product, { colours: ["#4A697B"], colourStyle: "striped" });
  assert.deepEqual([saved.body.product.colours, saved.body.product.colourStyle], [["#4A697B"], "striped"]);
  for (const bad of [["red"], ["#12345"], ["#111111", "#222222", "#333333"], "#111111"]) assert.equal((await put(saved.body.product, { colours: bad })).status, 400, JSON.stringify(bad));
  assert.equal((await put(saved.body.product, { colours: ["#111111"], colourStyle: "dotted" })).status, 400);
  saved = await put(saved.body.product, { colours: null });
  assert.equal(saved.status, 200); assert.equal(saved.body.product.colours, undefined, "null goes back to the packaging colour");
  const added = await call("POST", "/api/admin/wholesale/catalogue", { title: "Twin Peaks Blend", categories: ["blend"], prices: { quarter: 500, kilo: 1800 }, active: false, colours: ["#810A40"] });
  assert.equal(added.status, 201, added.text); assert.deepEqual(added.body.product.colours, ["#810A40"]);
  assert.equal((await call("PUT", `/api/admin/wholesale/catalogue/${added.body.product.id}`, { ifVersion: added.body.product.version, prices: added.body.product.prices, active: false, colours: ["#000000"] }, BUYER)).status >= 400, true, "customers can't change colours");
});
