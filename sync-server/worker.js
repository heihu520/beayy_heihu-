// Beayy 同步服务（sync.beayy.com）：只存设备上加密好的数据块，服务器读不到内容。
// 协议见 报告/方案_20261016_多设备同步.md。R2 存密文，D1 存账号（令牌只存哈希）和「哪个块什么时候更新过」的索引。
//
// v2 账号：邮箱＋主密码。主密码只在设备上用，派生出两把：登录校验值（服务器只存它的哈希）和包数据密钥的钥匙
// （服务器只存包好的数据密钥，解不开）。每台设备登录后拿自己的令牌，可单独移除。另有恢复码，忘了主密码时重设。

import PRIVACY_HTML from "./privacy.html";

const NAME = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_BLOB = 50 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
/** 设备上主密码派生用的参数（Argon2id）；服务器只是原样存取 */
const KDF = { alg: "argon2id", m: 65536, t: 3, p: 1 };

/** 录音块（audio.<段 id>）的兜底期限：电脑转写完 7 天后自己删；电脑关机太久没转的，到这个天数服务器删 */
const AUDIO_MAX_DAYS = 30;

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
  // 每天一次（wrangler.jsonc 的 triggers.crons）：删超期的录音块
  async scheduled(_event, env) {
    const cutoff = Date.now() - AUDIO_MAX_DAYS * 86400e3;
    for (;;) {
      const { results } = await env.DB.prepare("SELECT user, device, segment FROM blobs WHERE segment LIKE 'audio.%' AND updated < ? LIMIT 500").bind(cutoff).all();
      if (!results.length) break;
      await env.BUCKET.delete(results.map((r) => `${r.user}/${r.device}/${r.segment}`));
      await env.DB.batch(results.map((r) => env.DB.prepare("DELETE FROM blobs WHERE user = ? AND device = ? AND segment = ?").bind(r.user, r.device, r.segment)));
      if (results.length < 500) break;
    }
  },
};

/** 块的种类：按块名前缀（分段名以年份开头） */
function kindOf(device, segment) {
  if (device === "account") return "account";
  for (const k of ["audio", "transcript", "places", "sum"]) if (segment.startsWith(k + ".")) return k === "sum" ? "summary" : k;
  return segment === "names.json" ? "account" : "segment";
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.split("/").filter(Boolean);
  // 转写服务回报用量：不用账号令牌，用签名
  if (p[0] === "v2" && p[1] === "internal" && p[2] === "usage" && req.method === "POST") return internalUsage(req, env);
  if (p[0] === "v2") return v2(req, env, p.slice(1), url);
  // 自动更新：公开只读，R2 里 update/ 下的 latest.json 和安装包（放这里不放 GitHub，国内不翻墙也能下）
  if (p[0] === "update" && p.length === 2 && NAME.test(p[1]) && (req.method === "GET" || req.method === "HEAD")) {
    const o = await env.BUCKET.get("update/" + p[1]);
    if (!o) return json({ error: "没有这个文件" }, 404);
    return new Response(req.method === "HEAD" ? null : o.body, {
      headers: {
        "content-type": p[1].endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream",
        "content-length": String(o.size),
        "cache-control": p[1] === "latest.json" ? "no-cache" : "public, max-age=86400",
      },
    });
  }
  // 隐私政策（TestFlight 外部测试、App Store 要填的链接）
  if (p[0] === "privacy" && p.length === 1 && req.method === "GET") return new Response(PRIVACY_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
  if (p[0] === "_AMapService") return amapJsProxy(req, env, p, url);
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
    // 可按块名前缀（transcript.、audio.、places.）和设备筛
    const prefix = url.searchParams.get("prefix") || "";
    const device = url.searchParams.get("device") || "";
    if ((prefix && !/^[A-Za-z0-9._-]{1,40}$/.test(prefix)) || (device && !NAME.test(device))) return json({ error: "筛选条件不合法" }, 400);
    // 索引写明：从头按前缀列（0.2.19 及以前的客户端每轮都这样）走 (user, segment)，只读这一类；增量列走 (user, updated)，只读新来的。
    // D1 按读到的行计费，交给查询规划自己挑时两种都会挑错
    const index = prefix && !since ? "blobs_seg" : "blobs_updated";
    let sql = `SELECT device, segment, size, updated FROM blobs INDEXED BY ${index} WHERE user = ? AND updated > ?`;
    const args = [user, since];
    if (prefix) { sql += " AND segment >= ? AND segment < ?"; args.push(prefix, prefix + "\uffff"); }
    if (device) { sql += " AND device = ?"; args.push(device); }
    const { results } = await env.DB.prepare(sql + " ORDER BY updated LIMIT 5000").bind(...args).all();
    return json({ items: results, now: Date.now() });
  }

  // 这个账号在服务器上存了什么：按设备和种类合计（设置「数据」页用）
  if (p[1] === "usage" && req.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT device, segment, size, updated FROM blobs WHERE user = ?",
    ).bind(user).all();
    const m = new Map();
    for (const r of results) {
      const k = `${r.device}\u0000${kindOf(r.device, r.segment)}`;
      const x = m.get(k) || { device: r.device, kind: kindOf(r.device, r.segment), count: 0, bytes: 0, oldest: r.updated, newest: r.updated };
      x.count++; x.bytes += r.size; x.oldest = Math.min(x.oldest, r.updated); x.newest = Math.max(x.newest, r.updated);
      m.set(k, x);
    }
    return json({ items: [...m.values()], audio_max_days: AUDIO_MAX_DAYS, now: Date.now() });
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
  // 转写票据：给转写服务（hk2）认账号用，1 小时有效。转写服务只拿到这张票，拿不到能读写数据的同步令牌
  // 官方地图：地名、附近的店、搜地点、静态图走服务器的高德 Key；能缩放的地图拿公开的地图 Key＋安全密钥中转地址
  if (p[0] === "amap" && p.length >= 2 && M === "GET") return amapRest(env, user, p.slice(1).join("/"), url);
  if (p[0] === "amap-js" && M === "GET") return amapJsConfig(env, user, url);
  if (p[0] === "ticket" && M === "GET") {
    if (!env.TICKET_SECRET) return json({ error: "服务器没配转写票据" }, 503);
    // 票据是给官方服务（hk2）用的，分转写和地图两种：没开通、停用、这一项本月用完就不发
    const kind = url.searchParams.get("for") === "map" ? "map" : "asr";
    const q = await quota(env, user, kind);
    if (q.error) return json({ error: q.error }, q.status);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = b64url(new TextEncoder().encode(JSON.stringify(kind === "map" ? { u: user, exp, k: "map" } : { u: user, exp })));
    return json({ ticket: `${payload}.${await hmac(env.TICKET_SECRET, payload)}`, expires: exp * 1000 });
  }
  if (p[0] === "password" && M === "POST") {
    const b = await body(req);
    if (!credsOk(b)) return json({ error: "信息不全" }, 400);
    await env.DB.prepare("UPDATE users SET salt = ?, auth_hash = ?, wrapped_key = ? WHERE user = ?").bind(b.salt, await sha256(b.auth), b.wrapped_key, user).run();
    return json({ ok: true });
  }
  // 官方模型：开通了的账号经这里调，真正的模型密钥只在服务器上（LLM_KEY）。按月记 token，超额、没开通、停用都拒绝
  if (p[0] === "llm" && p[1] === "chat" && p[2] === "completions" && M === "POST") return llm(req, env, user);
  if (p[0] === "account" && M === "GET") {
    const me = await env.DB.prepare("SELECT email, display_name, avatar, profile_updated, llm_plan, llm_quota, llm_used, llm_month FROM users WHERE user = ?").bind(user).first();
    const { results } = await env.DB.prepare("SELECT id, name, device, created, last_seen FROM sessions WHERE user = ? ORDER BY created").bind(user).all();
    return json({
      user, email: me ? me.email : null, session: who.session, sessions: results,
      profile: me ? { name: me.display_name, avatar: me.avatar, updated: me.profile_updated } : null,
      llm: me ? { plan: me.llm_plan || null, quota: me.llm_quota, used: (await usageOf(env, user)).llm || 0, month: month() } : null,
      services: await services(env, user),
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

/** 这个月（UTC），额度按它清零 */
function month() {
  return new Date().toISOString().slice(0, 7);
}

const LLM_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------- 官方服务：模型（token）、转写（音频秒）、地图（次），按账号开通，每项每月一个上限 ----------

const SERVICE_NAMES = { llm: "模型", asr: "转写", map: "地图" };
const QUOTA_COL = { llm: "llm_quota", asr: "asr_quota", map: "map_quota" };

async function usageOf(env, user) {
  const { results } = await env.DB.prepare("SELECT service, used FROM usage WHERE user = ? AND month = ?").bind(user, month()).all();
  return Object.fromEntries(results.map((r) => [r.service, r.used]));
}

async function addUsage(env, user, service, n) {
  if (!(n > 0)) return;
  await env.DB.prepare("INSERT INTO usage (user, month, service, used) VALUES (?, ?, ?, ?) ON CONFLICT (user, month, service) DO UPDATE SET used = used + excluded.used")
    .bind(user, month(), service, Math.round(n)).run();
}

/** 这一项能不能用：{plan, used, quota} 或 {error, status} */
async function quota(env, user, service) {
  const u = await env.DB.prepare("SELECT llm_plan, llm_quota, asr_quota, map_quota FROM users WHERE user = ?").bind(user).first();
  if (!u || !u.llm_plan) return { error: "这个账号还没开通官方服务：联系管理员开通，或在设置里改用自己的", status: 403 };
  if (u.llm_plan === "stopped") return { error: "这个账号的官方服务已停用", status: 403 };
  const used = (await usageOf(env, user))[service] || 0;
  const q = u[QUOTA_COL[service]] || 0;
  if (q > 0 && used >= q) return { error: `本月官方${SERVICE_NAMES[service]}额度用完了，下个月 1 号恢复`, status: 429 };
  return { plan: u.llm_plan, used, quota: q };
}

/** 设置页显示：{plan, month, llm: {used, quota}, asr: {…}, map: {…}} */
async function services(env, user) {
  const u = await env.DB.prepare("SELECT llm_plan, llm_quota, asr_quota, map_quota FROM users WHERE user = ?").bind(user).first();
  const used = await usageOf(env, user);
  const one = (k) => ({ used: used[k] || 0, quota: (u && u[QUOTA_COL[k]]) || 0 });
  return { plan: (u && u.llm_plan) || null, month: month(), llm: one("llm"), asr: one("asr"), map: one("map") };
}

async function llm(req, env, user) {
  if (!env.LLM_GATEWAY || !env.LLM_KEY) return json({ error: "服务器没配官方模型" }, 503);
  const q = await quota(env, user, "llm");
  if (q.error) return json({ error: q.error }, q.status);
  const b = await body(req);
  if (!Array.isArray(b.messages) || !b.messages.length) return json({ error: "缺 messages" }, 400);
  // 只放行默认模型和这几个参数，别的不转
  const out = { model: env.LLM_MODEL || b.model, messages: b.messages, stream: false };
  for (const k of ["temperature", "max_tokens", "response_format"]) if (b[k] !== undefined) out[k] = b[k];
  const r = await fetch(env.LLM_GATEWAY.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_KEY}`, "user-agent": LLM_UA },
    body: JSON.stringify(out),
  });
  const text = await r.text();
  let v = null;
  try { v = JSON.parse(text); } catch (e) { /* 网关出错页 */ }
  if (!r.ok || !v) return json({ error: `官方模型出错（${r.status}）` }, 502);
  await addUsage(env, user, "llm", Number((v.usage && v.usage.total_tokens) || 0) || 0);
  return json(v);
}

/** 高德 Web 服务：只放行这几种，服务器带上自己的 Key，每次算 1 次 */
const AMAP_PATHS = new Set(["geocode/regeo", "geocode/geo", "place/around", "place/text", "staticmap"]);

async function amapRest(env, user, path, url) {
  if (!env.AMAP_KEY) return json({ error: "服务器没配官方地图" }, 503);
  if (!AMAP_PATHS.has(path)) return json({ error: "不支持这个地图接口" }, 400);
  const q = await quota(env, user, "map");
  if (q.error) return json({ error: q.error }, q.status);
  const qs = new URLSearchParams(url.search);
  qs.delete("key");
  qs.set("key", env.AMAP_KEY);
  const r = await fetch(`https://restapi.amap.com/v3/${path}?${qs}`);
  await addUsage(env, user, "map", 1);
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json; charset=utf-8" } });
}

/** 能缩放的地图：公开的地图 Key＋安全密钥中转地址（路径里带 1 小时的票据）；每打开一次地图算 1 次 */
async function amapJsConfig(env, user, url) {
  if (!env.AMAP_JS_KEY || !env.AMAP_JS_CODE || !env.TICKET_SECRET) return json({ error: "服务器没配官方地图" }, 503);
  const q = await quota(env, user, "map");
  if (q.error) return json({ error: q.error }, q.status);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ u: user, exp, k: "map" })));
  const ticket = `${payload}.${await hmac(env.TICKET_SECRET, payload)}`;
  await addUsage(env, user, "map", 1);
  // 安全密钥中转放在官方服务（hk2，香港，到高德快）；OFFICIAL_HOST 没配就用这里
  return json({ key: env.AMAP_JS_KEY, service_host: `${env.OFFICIAL_HOST || url.origin}/_AMapService/${ticket}` });
}

/** 高德官方的安全密钥中转写法：/_AMapService/<票据>/v4/map/styles → webapi，/v3/vectormap → fmap01，其余 → restapi，都补上 jscode */
async function amapJsProxy(req, env, p, url) {
  const user = await verifyTicket(env, p[1] || "");
  if (!user) return json({ error: "地图票据不对或过期了" }, 401);
  const rest = p.slice(2).join("/");
  const host = rest.startsWith("v4/map/styles") ? "https://webapi.amap.com" : rest.startsWith("v3/vectormap") ? "https://fmap01.amap.com" : "https://restapi.amap.com";
  const qs = new URLSearchParams(url.search);
  qs.set("jscode", env.AMAP_JS_CODE);
  const r = await fetch(`${host}/${rest}?${qs}`, { method: req.method === "POST" ? "POST" : "GET", body: req.method === "POST" ? await req.arrayBuffer() : undefined });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" } });
}

/** 票据（{u, exp}.HMAC）→ 账号；不对或过期返回 null */
async function verifyTicket(env, t) {
  const [payload, sig] = String(t).split(".");
  if (!payload || !sig || !env.TICKET_SECRET || !(await same(sig, await hmac(env.TICKET_SECRET, payload)))) return null;
  try {
    const d = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return d.exp * 1000 > Date.now() && /^[0-9a-f]{24}$/.test(d.u) ? d.u : null;
  } catch (e) {
    return null;
  }
}

/** 转写服务（hk2）回报用量：body {u, service, n, t}，头 x-sig＝HMAC(TICKET_SECRET, body)，t 在 10 分钟内 */
async function internalUsage(req, env) {
  const raw = await req.text();
  const sig = req.headers.get("x-sig") || "";
  if (!env.TICKET_SECRET || !(await same(sig, await hmac(env.TICKET_SECRET, raw)))) return json({ error: "签名不对" }, 401);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "不是 JSON" }, 400); }
  if (!/^[0-9a-f]{24}$/.test(b.u || "") || !SERVICE_NAMES[b.service] || Math.abs(Date.now() / 1000 - Number(b.t || 0)) > 600) return json({ error: "内容不对" }, 400);
  await addUsage(env, b.u, b.service, Number(b.n) || 0);
  return json({ ok: true });
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

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg))));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
