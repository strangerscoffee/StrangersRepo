import { DurableObject } from "cloudflare:workers";
import { emptyDocument, referencedMedia, validateDocument } from "../public/consumer-preview/assets/editor-model.js";
import { ApiError, type Env, errorResponse, invalid, json, readJson } from "./http";
import { editorMediaPath } from "./consumerEditorClient";
import { MAX_PHOTO_BYTES, readEditorPhoto } from "./consumerEditorPhoto";

type EditorDocument = ReturnType<typeof emptyDocument>;
type StateRow = { revision: number; draft: string; publishedRevision: number };
type ReleaseRow = { version: number; document: string; publishedAt: string };
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_MEDIA_COUNT = 150;
const RETAINED_RELEASES = 20;
const notFound = () => new ApiError(404, "not_found", "Storefront content not found.");

/** All mutable storefront content lives in a single consumer-only SQLite object. Transactions
 * compare revisions and switch the public snapshot together. No sessions or orders live here. */
export class ConsumerEditorStore extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS editor_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, draft TEXT NOT NULL, published_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (version INTEGER PRIMARY KEY, document TEXT NOT NULL, published_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS photo_uses (version INTEGER NOT NULL, photo TEXT NOT NULL, PRIMARY KEY (version,photo));
      CREATE INDEX IF NOT EXISTS photo_uses_photo ON photo_uses(photo)`);
    const empty = JSON.stringify(emptyDocument());
    this.sql.exec("INSERT OR IGNORE INTO editor_state VALUES(1, 0, ?, 0)", empty);
    this.sql.exec("INSERT OR IGNORE INTO releases VALUES(0, ?, ?)", empty, new Date().toISOString());
  }

  private current(): StateRow {
    return this.sql.exec<StateRow>("SELECT revision,draft,published_revision AS publishedRevision FROM editor_state WHERE id=1").one();
  }

  private state() {
    const { revision, draft, publishedRevision } = this.current();
    const published = this.sql.exec<{document: string}>("SELECT document FROM releases WHERE version=?", publishedRevision).one();
    return {
      revision, draft: JSON.parse(draft), publishedRevision, hasUnpublishedChanges: draft !== published.document,
      history: this.sql.exec("SELECT version,published_at AS publishedAt FROM releases ORDER BY version DESC").toArray(),
      media: this.sql.exec("SELECT id,name,type,bytes,created_at AS createdAt FROM photos ORDER BY created_at DESC,id").toArray(),
    };
  }

  private setPhotoUses(version: number, ids: string[]) {
    this.sql.exec("DELETE FROM photo_uses WHERE version=?", version);
    for (const id of new Set(ids)) {
      if (!this.sql.exec("SELECT 1 FROM photos WHERE id=?", id).toArray().length) {
        throw new ApiError(422, "missing_photo", "This photo is no longer in the media library. Choose another photo.");
      }
      this.sql.exec("INSERT INTO photo_uses VALUES(?,?)", version, id);
    }
  }

  private update(path: string, body: Record<string, unknown>) {
    const { revision, draft, publishedRevision } = this.current();
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw invalid("Include the editor revision.");
    if (body.revision !== revision) throw new ApiError(409, "editor_conflict", "Another admin has changed the storefront. Reload before saving.");
    if (path === "/") {
      let document: EditorDocument;
      try { document = validateDocument(body.document); }
      catch (error) { throw invalid(error instanceof TypeError ? error.message : "Check the storefront document."); }
      const value = JSON.stringify(document);
      if (value !== draft) {
        this.setPhotoUses(-1, [...referencedMedia(document)]);
        this.sql.exec("UPDATE editor_state SET revision=revision+1,draft=? WHERE id=1", value);
      }
    } else if (path === "/publish") {
      const live = this.sql.exec<{document: string}>("SELECT document FROM releases WHERE version=?", publishedRevision).one();
      if (draft !== live.document) {
        const version = revision + 1;
        this.sql.exec("INSERT INTO releases(version,document,published_at) VALUES(?,?,?)", version, draft, new Date().toISOString());
        this.sql.exec("INSERT INTO photo_uses SELECT ?,photo FROM photo_uses WHERE version=-1", version);
        this.sql.exec("UPDATE editor_state SET revision=?,published_revision=? WHERE id=1", version, version);
        this.sql.exec("DELETE FROM releases WHERE version>0 AND version NOT IN (SELECT version FROM releases ORDER BY version DESC LIMIT ?)", RETAINED_RELEASES);
        this.sql.exec("DELETE FROM photo_uses WHERE version>=0 AND version NOT IN (SELECT version FROM releases)");
      }
    } else {
      if (!Number.isSafeInteger(body.version) || (body.version as number) < 0) throw invalid("Choose a published version.");
      const target = this.sql.exec<ReleaseRow>("SELECT document FROM releases WHERE version=?", body.version).toArray()[0];
      if (!target) throw notFound();
      if (target.document !== draft) {
        this.sql.exec("DELETE FROM photo_uses WHERE version=-1");
        this.sql.exec("INSERT INTO photo_uses SELECT -1,photo FROM photo_uses WHERE version=?", body.version);
        this.sql.exec("UPDATE editor_state SET revision=revision+1,draft=? WHERE id=1", target.document);
      }
    }
    return json(this.state());
  }

  private photo(id: string, head: boolean, onlyPublished: boolean) {
    const columns = head ? "type,bytes" : "type,bytes,content";
    const restriction = onlyPublished ? " AND EXISTS (SELECT 1 FROM photo_uses u JOIN editor_state s ON u.version=s.published_revision WHERE u.photo=photos.id)" : "";
    const row = this.sql.exec<{type: string; bytes: number; content: ArrayBuffer}>(
      "SELECT " + columns + " FROM photos WHERE id=?" + restriction, id
    ).toArray()[0];
    if (!row) throw notFound();
    return new Response(head ? null : row.content, {headers: {
      "content-type": row.type, "content-length": String(row.bytes), "cache-control": "no-store",
      "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin",
    }});
  }

  private upload(body: Record<string, unknown>) {
    if (this.sql.exec<{n: number}>("SELECT count(*) AS n FROM photos").one().n >= MAX_MEDIA_COUNT) {
      throw new ApiError(409, "editor_media_full", "The media library holds 150 photos. Remove an unused photo to add another.");
    }
    const { name, type, data } = readEditorPhoto(body);
    const entry = {id: crypto.randomUUID(), name, type, bytes: data.byteLength, createdAt: new Date().toISOString()};
    this.sql.exec("INSERT INTO photos(id,name,type,bytes,created_at,content) VALUES(?,?,?,?,?,?)",
      entry.id, name, type, entry.bytes, entry.createdAt, data.buffer as ArrayBuffer);
    return json({media: entry}, 201);
  }

  private async request(req: Request) {
    const path = new URL(req.url).pathname;
    const read = req.method === "GET" || req.method === "HEAD";
    if ((path === "/public" || path === "/admin/published") && req.method === "GET") {
      const row = this.sql.exec<ReleaseRow>(`SELECT r.version,r.document FROM editor_state s
        JOIN releases r ON r.version=s.published_revision WHERE s.id=1`).one();
      if (path === "/public" && !row.version) return new Response(null, {status: 204});
      return json({revision: row.version, document: JSON.parse(row.document)});
    }
    if (path.startsWith("/public/") && read) {
      const id = editorMediaPath.exec(path.slice("/public".length))?.[1];
      if (id) return this.photo(id, req.method === "HEAD", true);
      throw notFound();
    }
    if (!path.startsWith("/admin/")) throw notFound();
    const action = path.slice("/admin".length), id = editorMediaPath.exec(action)?.[1];
    if (action === "/" && req.method === "GET") return json(this.state());
    if (id && read) return this.photo(id, req.method === "HEAD", false);
    if (id && req.method === "DELETE") {
      return this.ctx.storage.transactionSync(() => {
        if (this.sql.exec("SELECT 1 FROM photo_uses WHERE photo=? LIMIT 1", id).toArray().length) {
          throw new ApiError(409, "editor_media_referenced", "This photo is used by the draft or a retained published version. It can be deleted once those versions no longer use it.");
        }
        if (!this.sql.exec("DELETE FROM photos WHERE id=?", id).rowsWritten) throw notFound();
        return json({deleted: true});
      });
    }
    const upload = action === "/media" && req.method === "POST";
    const write = (action === "/" && req.method === "PUT") || (["/publish", "/restore"].includes(action) && req.method === "POST");
    if (!upload && !write) throw notFound();
    const body = await readJson(req, upload ? Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 2048 : MAX_DOCUMENT_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Send a storefront editing action.");
    // All awaited input has arrived before the comparison and write; pending concurrent requests
    // can only observe a committed draft, release, and matching photo-reference set.
    return this.ctx.storage.transactionSync(() => upload ? this.upload(body) : this.update(action, body));
  }

  async fetch(req: Request): Promise<Response> {
    try { return await this.request(req); }
    catch (error) {
      if (error instanceof ApiError) return errorResponse(error);
      throw error;
    }
  }
}
