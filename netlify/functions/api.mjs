// The Paragons blog API (Netlify Function + Netlify Blobs)
//   GET    /api/posts          -> list of posts (newest first)
//   GET    /api/posts/:id      -> one full post
//   POST   /api/posts          -> create a post  { title, body, image? }
//   PUT    /api/posts/:id      -> update a post  { title, body, image? | null }
//   DELETE /api/posts/:id      -> delete a post
//   GET    /api/image/:id      -> the post's image
//
// There is no login. If you ever want a simple passcode, set an environment
// variable called ADMIN_PASSCODE in Netlify. The admin page will then ask for it.

import { getStore } from "@netlify/blobs";

const MAX_BODY = 60000;
const MAX_TITLE = 140;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const ID_RE = /^[a-z0-9-]{1,90}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const clean = (value, max) => String(value ?? "").replace(/\r/g, "").trim().slice(0, max);

const slugify = (text) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "post";

function makeExcerpt(body) {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(##\s|[-*•]\s|>)/.test(l));
  const text = (line || body).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? text.slice(0, 177).trimEnd() + "…" : text;
}

function isAuthorised(req) {
  let pass = "";
  try {
    pass = (globalThis.Netlify && Netlify.env.get("ADMIN_PASSCODE")) || "";
  } catch (_) {
    pass = "";
  }
  return !pass || req.headers.get("x-admin-passcode") === pass;
}

function parseImage(dataUrl) {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!m) return { error: "That image could not be read." };
  const type = m[1].toLowerCase();
  if (!IMAGE_TYPES.has(type)) return { error: "Please use a JPG, PNG, WEBP or GIF image." };
  const bytes = Buffer.from(m[2].replace(/\s/g, ""), "base64");
  if (!bytes.length) return { error: "That image looks empty." };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: "That image is too large. Please use one under 4 MB." };
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { type, buffer };
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const posts = getStore({ name: "posts", consistency: "strong" });
  const images = getStore({ name: "images", consistency: "strong" });

  try {
    // ---------- images ----------
    if (parts[0] === "image" && parts[1] && req.method === "GET") {
      const id = parts[1];
      if (!ID_RE.test(id)) return json({ error: "Not found" }, 404);
      const found = await images.getWithMetadata(id, { type: "arrayBuffer" });
      if (!found || !found.data) return json({ error: "Not found" }, 404);
      return new Response(found.data, {
        headers: {
          "content-type": (found.metadata && found.metadata.contentType) || "image/jpeg",
          "cache-control": "public, max-age=3600",
        },
      });
    }

    if (parts[0] !== "posts") return json({ error: "Not found" }, 404);
    const id = parts[1];
    if (id && !ID_RE.test(id)) return json({ error: "Not found" }, 404);

    // ---------- read ----------
    if (req.method === "GET" && !id) {
      const { blobs } = await posts.list();
      const all = (await Promise.all(blobs.map((b) => posts.get(b.key, { type: "json" })))).filter(Boolean);
      all.sort((a, b) => String(b.created).localeCompare(String(a.created)));
      return json(
        all.map((p) => ({
          id: p.id,
          title: p.title,
          excerpt: makeExcerpt(p.body),
          image: p.image || null,
          created: p.created,
        })),
      );
    }

    if (req.method === "GET" && id) {
      const post = await posts.get(id, { type: "json" });
      return post ? json(post) : json({ error: "Not found" }, 404);
    }

    // ---------- write ----------
    if (!["POST", "PUT", "DELETE"].includes(req.method)) return json({ error: "Method not allowed" }, 405);
    if (!isAuthorised(req)) return json({ error: "A passcode is needed." }, 401);

    if (req.method === "DELETE") {
      if (!id) return json({ error: "Missing post id" }, 400);
      await posts.delete(id);
      await images.delete(id);
      return json({ ok: true });
    }

    if (Number(req.headers.get("content-length") || 0) > 7 * 1024 * 1024) {
      return json({ error: "That upload is too large." }, 413);
    }
    let input;
    try {
      input = await req.json();
    } catch (_) {
      return json({ error: "Invalid request." }, 400);
    }

    const title = clean(input.title, MAX_TITLE);
    const body = clean(input.body, MAX_BODY);
    if (!title) return json({ error: "Please add a title." }, 400);
    if (!body) return json({ error: "Please write the article." }, 400);

    let existing = null;
    if (req.method === "PUT") {
      if (!id) return json({ error: "Missing post id" }, 400);
      existing = await posts.get(id, { type: "json" });
      if (!existing) return json({ error: "Post not found" }, 404);
    }

    const now = new Date().toISOString();
    const postId = existing ? existing.id : `${Date.now().toString(36)}-${slugify(title)}`;
    let image = existing ? existing.image || null : null;

    if (input.image === null || input.image === "") {
      if (existing) await images.delete(postId);
      image = null;
    } else if (typeof input.image === "string" && input.image.startsWith("data:")) {
      const parsed = parseImage(input.image);
      if (parsed.error) return json({ error: parsed.error }, 400);
      await images.set(postId, parsed.buffer, { metadata: { contentType: parsed.type } });
      image = `/api/image/${postId}?v=${Date.now().toString(36)}`;
    }

    const post = {
      id: postId,
      title,
      body,
      image,
      created: existing ? existing.created : now,
      updated: now,
    };
    await posts.setJSON(postId, post);
    return json(post, existing ? 200 : 201);
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: "/api/*" };
