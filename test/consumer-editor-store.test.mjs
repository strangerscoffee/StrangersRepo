import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { admin, editorPath, retail, startEditorFixture } from "./editor-integration-fixture.mjs";

const diary = "https://staffstrangerscoffee.com";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAIHRFWHRDb21tZW50AGZpeHR1cmUtcHJpdmF0ZS1tZXRhZGF0YXYPUMQAAAAUSURBVHicY2Rg+M/AwMDEwMCAoAASQgEFkf1DqAAAAABJRU5ErkJggg==";
let fixture;
before(async () => { fixture = await startEditorFixture(); });
after(async () => { await fixture?.stop(); });

function api(path, method = "GET", body, headers = {}) {
  return fixture.request(admin, editorPath + path, method, body, fixture.cookie, {origin: admin, ...headers});
}
async function expect(response, status = 200) {
  const result = await response;
  const text = await result.text();
  assert.equal(result.status, status, text);
  return JSON.parse(text);
}

test("storefront changes require a current admin session on the admin origin", async () => {
  assert.equal((await fixture.request(admin, editorPath)).status, 401);
  await expect(fixture.request(admin, "/api/admin/users", "POST",
    {name: "Storefront Staff", username: "editor.staff", role: "staff", password: "temp-staff-pass"}, fixture.cookie));
  await fixture.request(diary, "/api/auth/login", "POST", {username: "editor.staff", password: "temp-staff-pass"});
  const changed = await fixture.request(diary, "/api/auth/change", "POST",
    {username: "editor.staff", password: "temp-staff-pass", newPassword: "new-staff-password"});
  assert.equal(changed.status, 200);
  const staffCookie = changed.headers.getSetCookie().find(c => /^sfbb_session=[\w-]+/.test(c)).split(";")[0];
  assert.equal((await fixture.request(admin, editorPath, "GET", undefined, staffCookie)).status, 403);
  assert.equal((await api("/publish", "POST", {revision: 0}, {origin: retail})).status, 403);
  assert.equal((await api("/publish", "POST", {revision: 0}, {origin: diary})).status, 403);
  assert.equal((await api("/publish", "POST", {revision: 0}, {"content-type": "text/plain"})).status, 415);
  assert.equal((await fixture.request(diary, editorPath, "GET", undefined, fixture.cookie)).status, 404);
});

test("draft photos, retained releases and optimistic editor revisions stay consistent", async () => {
  const initial = await expect(api(""));
  assert.equal(initial.revision, 0);
  assert.equal(initial.publishedRevision, 0);
  assert.equal(initial.hasUnpublishedChanges, false);
  assert.deepEqual(await expect(api("/published")), {revision: 0, document: initial.draft});
  const { media } = await expect(api("/media", "POST", {name: "Photo.png", type: "image/png", data: png}), 201);
  const mediaPath = "/media/" + media.id;
  const publicRead = (method = "GET") => fixture.request(retail, "/consumer-media/" + media.id, method);
  assert.equal((await publicRead()).status, 404);
  const photo = await api(mediaPath);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal(photo.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(await photo.arrayBuffer()).includes(Buffer.from("fixture-private-metadata")), false);

  const document = structuredClone(initial.draft);
  document.pages.home = {widgets: [{id: "w-photo", type: "image", image: "media:" + media.id, alt: "A coffee on the bar."}]};
  const changed = await expect(api("", "PUT", {revision: 0, document}));
  assert.equal(changed.hasUnpublishedChanges, true);
  assert.ok(changed.revision > 0);
  assert.equal((await expect(api("/publish", "POST", {revision: 0}), 409)).code, "editor_conflict");
  assert.equal((await expect(api(mediaPath, "DELETE"), 409)).code, "editor_media_referenced");
  assert.equal((await publicRead()).status, 404);
  const unrelated = structuredClone(document);
  unrelated.pages.home.widgets[0].image = "media:00000000-0000-4000-8000-000000000001";
  assert.equal((await expect(api("", "PUT", {revision: changed.revision, document: unrelated}), 422)).code, "missing_photo");
  assert.equal((await expect(api(""))).revision, changed.revision);
  const live = await expect(api("/publish", "POST", {revision: changed.revision}));
  assert.equal(live.hasUnpublishedChanges, false);
  assert.ok(live.publishedRevision > 0);
  assert.deepEqual(await expect(api("/published")), {revision: live.publishedRevision, document: live.draft});
  const visible = await publicRead("HEAD");
  assert.equal(visible.status, 200);
  assert.equal(visible.headers.get("content-length"), String(media.bytes));
  assert.equal(await visible.text(), "");

  const restored = await expect(api("/restore", "POST", {revision: live.revision, version: 0}));
  assert.equal(restored.publishedRevision, live.publishedRevision);
  assert.equal((await publicRead()).status, 200, "restoring a draft leaves the published photo in place");
  const removed = await expect(api("/publish", "POST", {revision: restored.revision}));
  assert.equal((await publicRead()).status, 404);
  assert.equal((await expect(api(mediaPath, "DELETE"), 409)).code, "editor_media_referenced");
  const back = await expect(api("/restore", "POST", {revision: removed.revision, version: live.publishedRevision}));
  assert.equal(back.draft.pages.home.widgets[0].image, "media:" + media.id);
  assert.equal((await publicRead()).status, 404);

  const final = await expect(api("/restore", "POST", {revision: back.revision, version: 0}));
  let state = final;
  for (let i = 0; i < 20; i++) {
    const tweak = structuredClone(initial.draft);
    tweak.pages.home = {widgets: [{id: "w-message", type: "callout", heading: "Release " + i}]};
    state = await expect(api("", "PUT", {revision: state.revision, document: tweak}));
    state = await expect(api("/publish", "POST", {revision: state.revision}));
  }
  assert.equal(state.history.length, 21);
  assert.ok(state.history.some(entry => entry.version === 0));
  assert.ok(!state.history.some(entry => entry.version === live.publishedRevision));
  assert.equal((await api("/restore", "POST", {revision: state.revision, version: live.publishedRevision})).status, 404);
  assert.deepEqual(await expect(api(mediaPath, "DELETE")), {deleted: true});
  assert.equal((await api(mediaPath)).status, 404);
});

test("the photo library checks the actual raster format and supports removing unused uploads", async () => {
  for (const data of [{name:"file.png", type:"image/jpeg", data:png},
    {name:"file.jpg", type:"image/jpeg", data:"/9j/2Q=="}, {name:"file.svg", type:"image/svg+xml", data:"PHN2Zz4="}]) {
    assert.equal((await api("/media", "POST", data)).status, 400);
  }
  const jpeg = await readFile(new URL("../docs/rota-screenshots/today.jpg", import.meta.url));
  // A phone may write both camera orientation and identifying metadata. Only
  // the orientation tag should survive the server-side upload.
  const exif = Buffer.from("Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0fixture-private-metadata", "latin1");
  const marker = Buffer.from([0xff, 0xe1, 0, exif.length + 2]);
  const camera = Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
  const result = await expect(api("/media", "POST", {name:"Camera.jpg", type:"image/jpeg", data:camera.toString("base64")}), 201);
  const cleaned = Buffer.from(await (await api("/media/" + result.media.id)).arrayBuffer());
  assert.ok(cleaned.includes(exif.subarray(0, 32)), "keep the tag that displays the camera photo upright");
  assert.equal(cleaned.includes(Buffer.from("fixture-private-metadata")), false);
  await expect(api("/media/" + result.media.id, "DELETE"));

  const file = await readFile(new URL("../public/consumer-preview/assets/hero.webp", import.meta.url));
  const {media} = await expect(api("/media", "POST", {name:"Hero.webp", type:"image/webp", data:file.toString("base64")}), 201);
  await expect(api("/media/" + media.id, "DELETE"));
  assert.equal((await api("/media/" + media.id)).status, 404);
  assert.equal((await fixture.request(retail, "/consumer-media/" + media.id)).status, 404);
});

test("an uploaded photo used only for social sharing follows the page's publication", async () => {
  const {media} = await expect(api("/media","POST",{name:"Share card.png",type:"image/png",data:png}),201);
  const path = "/consumer-media/" + media.id;
  const initial = await expect(api(""));
  const draft = structuredClone(initial.draft);
  draft.pages.about = {meta:{socialImage:"media:" + media.id,socialImageAlt:"Strangers Coffee"}};
  const saved = await expect(api("","PUT",{revision:initial.revision,document:draft}));
  assert.equal((await fixture.request(retail,path,"HEAD")).status,404);
  assert.equal((await api("/media/" + media.id,"DELETE")).status,409);
  const published = await expect(api("/publish","POST",{revision:saved.revision}));
  assert.equal((await fixture.request(retail,path,"HEAD")).status,200);
  const page = await fixture.request(retail,"/about/").then(r => r.text());
  assert.ok(page.includes('<meta property="og:image" content="' + retail + path + '">'));
  const removed = await expect(api("","PUT",{revision:published.revision,document:initial.draft}));
  await expect(api("/publish","POST",{revision:removed.revision}));
  assert.equal((await fixture.request(retail,path,"HEAD")).status,404);
  assert.equal((await api("/media/" + media.id,"DELETE")).status,409,'retained published version still protects its photo');
});
