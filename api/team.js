// ============================================================================
// Live team sync — GET/PUT one JSON document per team, stored in Vercel Blob.
//
// Auth model: a team has a public `id` (short, shareable, read-only) and a
// secret `key` held only by the owner. First PUT for an id claims it and
// stores a hash of the key; later PUTs must present the matching key. Reads
// need only the id, so league-mates can look but not touch.
//
// The key is never returned by the API and only its SHA-256 is persisted.
// ============================================================================

import { put, list } from "@vercel/blob";
import { createHash } from "node:crypto";

const MAX_BYTES = 512 * 1024; // one roster is ~4 KB; this is a generous ceiling
const ID_RE = /^[a-z0-9]{6,32}$/;

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const pathFor = (id) => `teams/${id}.json`;

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
}

/** Blob URLs are unguessable, so find the current one by prefix. */
async function findBlob(id) {
  const { blobs } = await list({ prefix: pathFor(id), limit: 1 });
  return blobs && blobs.length ? blobs[0] : null;
}

async function readRecord(id) {
  const blob = await findBlob(id);
  if (!blob) return null;
  // Overwriting keeps the same blob URL, and that URL is CDN-cached — without
  // a unique query the read can serve the previous version straight after a
  // write. `uploadedAt` changes on every put, so it busts the cache while
  // still being stable enough to hit cache on repeat reads of the same version.
  const stamp = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : Date.now();
  const url = `${blob.url}${blob.url.includes("?") ? "&" : "?"}v=${stamp}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Huddle-Key");
  if (req.method === "OPTIONS") return res.status(204).end();

  const id = String(req.query.id || "").toLowerCase();
  if (!ID_RE.test(id)) return send(res, 400, { error: "Bad team id" });

  try {
    if (req.method === "GET") {
      const rec = await readRecord(id);
      if (!rec) return send(res, 404, { error: "No team with that code" });
      return send(res, 200, { id, state: rec.state, updatedAt: rec.updatedAt });
    }

    if (req.method === "PUT") {
      const key = req.headers["x-huddle-key"];
      if (!key || String(key).length < 8) return send(res, 401, { error: "Missing write key" });

      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (!body || typeof body.state !== "object" || body.state === null) {
        return send(res, 400, { error: "Missing state" });
      }
      const payload = JSON.stringify(body.state);
      if (Buffer.byteLength(payload, "utf8") > MAX_BYTES) {
        return send(res, 413, { error: "Team data too large" });
      }

      const existing = await readRecord(id);
      if (existing && existing.keyHash !== sha256(key)) {
        return send(res, 403, { error: "That code belongs to someone else" });
      }

      const record = {
        keyHash: sha256(key),
        state: body.state,
        updatedAt: Date.now(),
      };
      await put(pathFor(id), JSON.stringify(record), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });
      return send(res, 200, { id, updatedAt: record.updatedAt, claimed: !existing });
    }

    return send(res, 405, { error: "Method not allowed" });
  } catch (err) {
    return send(res, 500, { error: "Sync failed", detail: String(err && err.message) });
  }
}
