// Beayy 同步服务（sync.beayy.com）：只存设备上加密好的数据块，服务器读不到内容。
// 协议见 报告/方案_20261016_多设备同步.md。R2 存密文，D1 存账号（令牌只存哈希）和「哪个块什么时候更新过」的索引。
//
// v2 账号：邮箱＋主密码。主密码只在设备上用，派生出两把：登录校验值（服务器只存它的哈希）和包数据密钥的钥匙
// （服务器只存包好的数据密钥，解不开）。每台设备登录后拿自己的令牌，可单独移除。另有恢复码，忘了主密码时重设。

const NAME = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_BLOB = 50 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
/** 设备上主密码派生用的参数（Argon2id）；服务器只是原样存取 */
const KDF = { alg: "argon2id", m: 65536, t: 3, p: 1 };

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean);
  if (p[0] === "v2") return v2(req, env, p.slice(1), url);
  if (p[0] !== "v1") return json({ error: "没有这个接口" }, 404);

  if (p[1] === "register" && req.method === "POST") {
    // 第一版要邀请码，防止被陌生人注册
    const invite = req.headers.get("x-invite") || "";
    if (!env.INVITE || !(await same(invite, env.INVITE))) return json({ error: "邀请码不对" }, 403);
    const user = hex(rand(12));
    const token = hex(rand(32));
    await env.DB.prepare("INSERT INTO users (user, token_hash, created) VALUES (?, ?, ?)").bind(user, await sha256(token), Date.now()).run();
    return json({ user, token });
  }

  const who = await auth(req, env);
  if (!who) return json({ error: "没登录或令牌不对" }, 401);
  const user = who.user;

  if (p[1] === "blob" && p.length === 4) {
    const [device, segment] = [p[2], p[3]];
    if (!NAME.test(device) || !NAME.test(segment)) return json({ error: "设备名或分段名不合法" }, 400);
    const key = `${user}/${device}/${segment}`;
    if (req.method === "PUT") {
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_BLOB) return json({ error: "太大了" }, 413);
      await env.BUCKET.put(key, body);
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO blobs (user, device, segment, size, updated) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (user, device, segment) DO UPDATE SET size = excluded.size, updated = excluded.updated",
      ).bind(user, device, segment, body.byteLength, now).run();
      return json({ updated: now });
    }
    if (req.method === "GET") {
      const obj = await env.BUCKET.get(key);
      if (!obj) return json({ error: "没有这个块" }, 404);
      return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
    }
    if (req.method === "DELETE") {
      await env.BUCKET.delete(key);
      await env.DB.prepare("DELETE FROM blobs WHERE user = ? AND device = ? AND segment = ?").bind(user, device, segment).run();
      return json({ ok: true });
    }
  }

  if (p[1] === "list" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const { results } = await env.DB.prepare(
      "SELECT device, segment, size, updated FROM blobs WHERE user = ? AND updated > ? ORDER BY updated LIMIT 5000",
    ).bind(user, since).all();
    return json({ items: results, now: Date.now() });
  }

  if (p[1] === "devices" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT device, COUNT(*) AS segments, SUM(size) AS bytes, MAX(updated) AS updated FROM blobs WHERE user = ? GROUP BY device ORDER BY device",
    ).bind(user).all();
    return json({ devices: results });
  }

  if (p[1] === "account" && req.method === "DELETE") {
    // 删账号：先删 R2 里这个账号的全部块，再删索引和账号
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix: `${user}/`, cursor });
      if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM blobs WHERE user = ?").bind(user),
      env.DB.prepare("DELETE FROM sessions WHERE user = ?").bind(user),
      env.DB.prepare("DELETE FROM users WHERE user = ?").bind(user),
    ]);
    return json({ ok: true });
  }

  return json({ error: "没有这个接口" }, 404);
}

/** Authorization: Bearer <user>:<token> → {user, session}。令牌可以是设备登录的（sessions），也可以是 v1 共用令牌 */
async function auth(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([0-9a-f]{24}):([0-9a-f]{64})$/);
  if (!m) return null;
  const h = await sha256(m[2]);
  const s = await env.DB.prepare("SELECT id, last_seen FROM sessions WHERE user = ? AND token_hash = ?").bind(m[1], h).first();
  if (s) {
    if (Date.now() - s.last_seen > 3600e3) await env.DB.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").bind(Date.now(), s.id).run();
    return { user: m[1], session: s.id };
  }
  const row = await env.DB.prepare("SELECT token_hash FROM users WHERE user = ?").bind(m[1]).first();
  if (!row) return null;
  return (await same(h, row.token_hash)) ? { user: m[1], session: null } : null;
}

// ---------- v2：账号 ----------

async function body(req) {
  try { return await req.json(); } catch (e) { return {}; }
}

/** 这台设备登录：发一个设备令牌 */
async function newSession(env, user, name, device) {
  const id = hex(rand(8));
  const token = hex(rand(32));
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user, name, device, token_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user, String(name || "").slice(0, 80), String(device || "").slice(0, 80), await sha256(token), now, now).run();
  return { session: id, token };
}

function credsOk(b) {
  return typeof b.salt === "string" && /^[0-9a-f]{32}$/.test(b.salt) && HEX64.test(b.auth || "") && typeof b.wrapped_key === "string" && b.wrapped_key.length < 400;
}

async function v2(req, env, p, url) {
  const M = req.method;
  // 登录前：取这个邮箱的盐和派生参数（没注册的邮箱给一个固定的假盐，免得被拿来试哪些邮箱注册过）
  if (p[0] === "prelogin" && M === "GET") {
    const email = (url.searchParams.get("email") || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT salt, kdf FROM users WHERE email = ?").bind(email).first();
    if (row && row.salt) return json({ salt: row.salt, kdf: JSON.parse(row.kdf) });
    return json({ salt: (await sha256("beayy-fake-salt:" + env.INVITE + ":" + email)).slice(0, 32), kdf: KDF });
  }
  if (p[0] === "register" && M === "POST") {
    const b = await body(req);
    if (!env.INVITE || !(await same(String(b.invite || ""), env.INVITE))) return json({ error: "邀请码不对" }, 403);
    const email = String(b.email || "").trim().toLowerCase();
    if (!EMAIL.test(email) || !credsOk(b) || !HEX64.test(b.recovery || "")) return json({ error: "注册信息不全" }, 400);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return json({ error: "这个邮箱已经注册过了" }, 409);
    const user = hex(rand(12));
    await env.DB.prepare("INSERT INTO users (user, token_hash, created, email, salt, kdf, auth_hash, wrapped_key, recovery_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(user, await sha256(hex(rand(32))), Date.now(), email, b.salt, JSON.stringify(KDF), await sha256(b.auth), b.wrapped_key, await sha256(b.recovery)).run();
    return json({ user, ...(await newSession(env, user, b.name, b.device)) });
  }
  if (p[0] === "login" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT user, auth_hash, wrapped_key, fails, locked_until FROM users WHERE email = ?").bind(email).first();
    if (row && row.locked_until > Date.now()) return json({ error: "密码错太多次，15 分钟后再试" }, 429);
    if (!row || !row.auth_hash || !HEX64.test(b.auth || "") || !(await same(await sha256(b.auth), row.auth_hash))) {
      if (row) {
        const fails = row.fails + 1;
        await env.DB.prepare("UPDATE users SET fails = ?, locked_until = ? WHERE user = ?").bind(fails % 10, fails >= 10 ? Date.now() + 15 * 60e3 : 0, row.user).run();
      }
      return json({ error: "邮箱或主密码不对" }, 401);
    }
    await env.DB.prepare("UPDATE users SET fails = 0, locked_until = 0 WHERE user = ?").bind(row.user).run();
    return json({ user: row.user, wrapped_key: row.wrapped_key, ...(await newSession(env, row.user, b.name, b.device)) });
  }
  // 忘了主密码：用恢复码重设（设备上用恢复码拿回数据密钥，重新包一层）；之前登录的设备全部登出
  if (p[0] === "recover" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const row = await env.DB.prepare("SELECT user, recovery_hash FROM users WHERE email = ?").bind(email).first();
    if (!row || !row.recovery_hash || !HEX64.test(b.recovery || "") || !(await same(await sha256(b.recovery), row.recovery_hash)) || !credsOk(b))
      return json({ error: "邮箱或恢复码不对" }, 401);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET salt = ?, auth_hash = ?, wrapped_key = ?, fails = 0, locked_until = 0 WHERE user = ?").bind(b.salt, await sha256(b.auth), b.wrapped_key, row.user),
      env.DB.prepare("DELETE FROM sessions WHERE user = ?").bind(row.user),
    ]);
    return json({ ok: true });
  }

  const who = await auth(req, env);
  if (!who) return json({ error: "没登录或令牌不对" }, 401);
  const user = who.user;
  // v1 账号设邮箱和主密码（迁移）：用旧的共用令牌登录着，把同一把数据密钥包一层存上来
  if (p[0] === "claim" && M === "POST") {
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    if (!EMAIL.test(email) || !credsOk(b) || !HEX64.test(b.recovery || "")) return json({ error: "信息不全" }, 400);
    const me = await env.DB.prepare("SELECT email FROM users WHERE user = ?").bind(user).first();
    if (me && me.email) return json({ error: "这个账号已经有邮箱了" }, 409);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) return json({ error: "这个邮箱已经注册过了" }, 409);
    await env.DB.prepare("UPDATE users SET email = ?, salt = ?, kdf = ?, auth_hash = ?, wrapped_key = ?, recovery_hash = ? WHERE user = ?")
      .bind(email, b.salt, JSON.stringify(KDF), await sha256(b.auth), b.wrapped_key, await sha256(b.recovery), user).run();
    return json({ user, ...(await newSession(env, user, b.name, b.device)) });
  }
  if (p[0] === "password" && M === "POST") {
    const b = await body(req);
    if (!credsOk(b)) return json({ error: "信息不全" }, 400);
    await env.DB.prepare("UPDATE users SET salt = ?, auth_hash = ?, wrapped_key = ? WHERE user = ?").bind(b.salt, await sha256(b.auth), b.wrapped_key, user).run();
    return json({ ok: true });
  }
  if (p[0] === "account" && M === "GET") {
    const me = await env.DB.prepare("SELECT email, display_name, avatar, profile_updated FROM users WHERE user = ?").bind(user).first();
    const { results } = await env.DB.prepare("SELECT id, name, device, created, last_seen FROM sessions WHERE user = ? ORDER BY created").bind(user).all();
    return json({
      user, email: me ? me.email : null, session: who.session, sessions: results,
      profile: me ? { name: me.display_name, avatar: me.avatar, updated: me.profile_updated } : null,
    });
  }
  // 显示名称和头像
  if (p[0] === "profile" && M === "POST") {
    const b = await body(req);
    const name = String(b.name || "").trim().slice(0, 40);
    const avatar = b.avatar == null ? null : String(b.avatar);
    if (avatar && (!avatar.startsWith("data:image/") || avatar.length > 300000)) return json({ error: "头像要是图片，且不超过 300KB" }, 400);
    const now = Date.now();
    await env.DB.prepare("UPDATE users SET display_name = ?, avatar = ?, profile_updated = ? WHERE user = ?").bind(name || null, avatar, now, user).run();
    return json({ updated: now });
  }
  // 移除一台设备的登录（自己退出登录也走这个，id 写 self）
  if (p[0] === "sessions" && p[1] && M === "DELETE") {
    const id = p[1] === "self" ? who.session : p[1];
    if (!id) return json({ error: "这个令牌不是设备登录的" }, 400);
    await env.DB.prepare("DELETE FROM sessions WHERE user = ? AND id = ?").bind(user, id).run();
    return json({ ok: true });
  }
  return json({ error: "没有这个接口" }, 404);
}

function rand(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

/** 定时比较两个字符串（先各自哈希，长度一样再逐字节比） */
async function same(a, b) {
  const [x, y] = [await sha256(a), await sha256(b)];
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
