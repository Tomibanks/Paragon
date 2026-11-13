// The Paragons blog API (Netlify Function + Netlify Blobs)
//   GET    /api/posts          -> list of posts (newest first)
//   GET    /api/posts/:id      -> one full post
//   POST   /api/posts          -> create a post  { title, body, image? }
//   PUT    /api/posts/:id      -> update a post  { title, body, image? | null }
//   DELETE /api/posts/:id      -> delete a post
//   GET    /api/image/:id      -> a post or nugget image
//
//   GET    /api/nuggets        -> Daily Nuggets (newest first)
//   POST   /api/nuggets        -> add a nugget  { image, ref?, text?, tr? }
//   PUT    /api/nuggets/:id    -> change a nugget
//   DELETE /api/nuggets/:id    -> delete a nugget
//
//   POST   /api/track          -> the website reports a page view or a click (anonymous)
//   GET    /api/stats?days=30  -> visitor numbers for the admin Visitors tab
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

async function handleNuggets(req, parts, images) {
  const store = getStore({ name: "nuggets", consistency: "strong" });
  const id = parts[1];
  if (id && !ID_RE.test(id)) return json({ error: "Not found" }, 404);

  if (req.method === "GET" && !id) {
    const { blobs } = await store.list();
    const all = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    all.sort((a, b) => String(b.created).localeCompare(String(a.created)));
    return json(all);
  }
  if (!["POST", "PUT", "DELETE"].includes(req.method)) return json({ error: "Method not allowed" }, 405);
  if (!isAuthorised(req)) return json({ error: "A passcode is needed." }, 401);

  if (req.method === "DELETE") {
    if (!id) return json({ error: "Missing nugget id" }, 400);
    await store.delete(id);
    await images.delete(`nugget-${id}`);
    return json({ ok: true });
  }

  if (Number(req.headers.get("content-length") || 0) > 7 * 1024 * 1024) return json({ error: "That upload is too large." }, 413);
  let input;
  try {
    input = await req.json();
  } catch (_) {
    return json({ error: "Invalid request." }, 400);
  }
  const ref = clean(input.ref, 60);
  const text = clean(input.text, 1500);
  const tr = clean(input.tr, 20);

  let existing = null;
  if (req.method === "PUT") {
    if (!id) return json({ error: "Missing nugget id" }, 400);
    existing = await store.get(id, { type: "json" });
    if (!existing) return json({ error: "Nugget not found" }, 404);
  }
  const nid = existing ? existing.id : Date.now().toString(36);
  let image = existing ? existing.image : null;
  const hasNew = typeof input.image === "string" && input.image.startsWith("data:");
  if (!existing && !hasNew) return json({ error: "Please add the nugget picture." }, 400);
  if (hasNew) {
    const parsed = parseImage(input.image);
    if (parsed.error) return json({ error: parsed.error }, 400);
    await images.set(`nugget-${nid}`, parsed.buffer, { metadata: { contentType: parsed.type } });
    image = `/api/image/nugget-${nid}?v=${Date.now().toString(36)}`;
  }
  const now = new Date().toISOString();
  const nugget = { id: nid, ref, text, tr, image, created: existing ? existing.created : now, updated: now };
  await store.setJSON(nid, nugget);
  return json(nugget, existing ? 200 : 201);
}

// ---------------------------------------------------------------------------
// Visitor statistics (anonymous: no cookies, no IP addresses stored)
// ---------------------------------------------------------------------------
const BOT_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget|python-requests/i;
const CLICK_KEYS = new Set(["whatsapp", "instagram", "register", "church", "share"]);
const LEGACY_POST = { id: "learn-to-build", title: "Your Certificate Is Not Enough. Learn to Build!" };
const statsStore = () => getStore({ name: "stats", consistency: "strong" });
// "today" follows Lagos time (UTC+1)
const dayOf = (ms = Date.now()) => new Date(ms + 3600 * 1000).toISOString().slice(0, 10);

function deviceOf(ua) {
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) return "t";
  if (/mobi|iphone|ipod|android/i.test(ua)) return "m";
  return "d";
}
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

async function visitorId(st, ip, ua, day) {
  let salt = await st.get("salt");
  if (!salt) {
    salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
    await st.set("salt", salt);
  }
  const bytes = new TextEncoder().encode(`${salt}|${day}|${ip}|${ua}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Every visit is saved as its own tiny record, so two people arriving at the same moment never overwrite each other.
async function handleTrack(req, context) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const ua = req.headers.get("user-agent") || "";
  if (!ua || BOT_RE.test(ua)) return new Response(null, { status: 204 });
  let input;
  try {
    const text = await req.text();
    if (text.length > 2000) return new Response(null, { status: 204 });
    input = JSON.parse(text);
  } catch (_) {
    return new Response(null, { status: 204 });
  }
  const st = statsStore();
  const day = dayOf();
  let ev;
  if (input.t === "view") {
    const p = String(input.p || "/");
    if (!/^\/(blog|post\/[a-z0-9-]{1,90})?$/.test(p)) return new Response(null, { status: 204 });
    ev = { p };
    if (input.first) {
      const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "0";
      const cc = String((context && context.geo && context.geo.country && context.geo.country.code) || "??").slice(0, 2).toUpperCase();
      const ref = String(input.r || "").toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 60) || "direct";
      ev.id = await visitorId(st, ip, ua, day);
      ev.a = `${cc}|${deviceOf(ua)}|${ref}`;
    }
  } else if (input.t === "click" && CLICK_KEYS.has(input.k)) {
    ev = { k: input.k };
  } else {
    return new Response(null, { status: 204 });
  }
  const key = `e:${day}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await st.setJSON(key, ev);
  return new Response(null, { status: 204 });
}

// Adds up one day. Finished days are saved as a single summary so they load fast next time.
async function loadDay(st, day, isToday) {
  if (!isToday) {
    const saved = await st.get(`s:${day}`, { type: "json" });
    if (saved) return saved;
  }
  const { blobs } = await st.list({ prefix: `e:${day}:` });
  const keys = blobs.map((b) => b.key).slice(0, 5000);
  const sum = { views: 0, visitors: {}, pages: {}, clicks: {} };
  for (let i = 0; i < keys.length; i += 40) {
    const events = await Promise.all(keys.slice(i, i + 40).map((k) => st.get(k, { type: "json" })));
    for (const e of events) {
      if (!e) continue;
      if (e.k) bump(sum.clicks, e.k);
      else if (e.p) {
        sum.views += 1;
        bump(sum.pages, e.p);
        if (e.id && !sum.visitors[e.id]) sum.visitors[e.id] = e.a;
      }
    }
  }
  if (!isToday) {
    await st.setJSON(`s:${day}`, sum);
    await Promise.all(keys.slice(0, 300).map((k) => st.delete(k)));
  }
  return sum;
}

async function handleStats(req, url) {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorised(req)) return json({ error: "A passcode is needed." }, 401);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 30));
  const st = statsStore();
  const list = [];
  for (let i = days - 1; i >= 0; i--) list.push(dayOf(Date.now() - i * 86400000));
  const today = list[list.length - 1];
  const sums = [];
  for (let i = 0; i < list.length; i += 10) {
    sums.push(...(await Promise.all(list.slice(i, i + 10).map((d) => loadDay(st, d, d === today)))));
  }
  const pages = {}, clicks = {}, refs = {}, countries = {}, devices = { m: 0, d: 0, t: 0 };
  const series = list.map((d, i) => {
    const s = sums[i];
    for (const [p, n] of Object.entries(s.pages || {})) bump(pages, p, n);
    for (const [k, n] of Object.entries(s.clicks || {})) bump(clicks, k, n);
    for (const val of Object.values(s.visitors || {})) {
      const [cc, dv, ref] = String(val).split("|");
      bump(countries, cc);
      if (devices[dv] !== undefined) devices[dv] += 1;
      bump(refs, ref);
    }
    return { d, views: s.views || 0, visitors: Object.keys(s.visitors || {}).length };
  });
  const names = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (_) { return null; } })();
  const top = (o, n = 8) => Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n);

  const titles = { [LEGACY_POST.id]: LEGACY_POST.title };
  const posts = getStore({ name: "posts", consistency: "strong" });
  const postPages = Object.entries(pages).filter(([p]) => p.startsWith("/post/"));
  await Promise.all(postPages.map(async ([p]) => {
    const id = p.slice(6);
    if (titles[id]) return;
    const rec = await posts.get(id, { type: "json" });
    titles[id] = rec ? rec.title : id;
  }));
  const now = series[series.length - 1];
  return json({
    days,
    today: { views: now.views, visitors: now.visitors },
    totals: { views: series.reduce((s, x) => s + x.views, 0), visitors: series.reduce((s, x) => s + x.visitors, 0) },
    series,
    pages: top(Object.fromEntries(Object.entries(pages).filter(([p]) => !p.startsWith("/post/")))).map(([p, n]) => ({ p, n })),
    posts: top(Object.fromEntries(postPages.map(([p, n]) => [p.slice(6), n]))).map(([id, n]) => ({ id, title: titles[id], n })),
    referrers: top(refs).map(([host, n]) => ({ host, n })),
    countries: top(countries).map(([cc, n]) => ({ cc, name: cc === "??" ? "Unknown" : (names && names.of(cc)) || cc, n })),
    devices: { mobile: devices.m, desktop: devices.d, tablet: devices.t },
    clicks,
  });
}

export default async (req, context) => {
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

    if (parts[0] === "track") return await handleTrack(req, context);
    if (parts[0] === "stats") return await handleStats(req, url);
    if (parts[0] === "nuggets") return await handleNuggets(req, parts, images);

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
