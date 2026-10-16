//! 给网页的取数命令（清单见 COMMANDS.md）。口径和 app/ui/mock/生成样例.py 一致：
//! 读仓库的 日数据/日数据_*.json、日总结/日总结_*.md，本机 Beayy/summaries/ 的自采摘要，
//! Beayy/devices/iphone-*/ 的 iPhone 前台事件（手机算法同 脚本/日数据包.py 的 section_phone）。
//! 读的都是正式数据目录（并跑版自己写影子目录，但页面看正式数据）。

use beayy_core::default_root;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

const PICKUP_GAP: f64 = 60.0;
const HARD_STOP: u32 = 21;
const LOCK_ID: &str = "com.apple.SleepLockScreen";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn settings_path() -> PathBuf {
    default_root().join("settings.json")
}

fn read_settings_raw() -> Map<String, Value> {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 外部数据目录（可选）：放着别的工具生成的 日数据/日数据_*.json、日总结/日总结_*.md。没填就只用 app 自己的数据
pub fn repo_path() -> Option<PathBuf> {
    match read_settings_raw().get("repo_path").and_then(|v| v.as_str()) {
        Some(p) if p.starts_with("~/") => Some(home().join(&p[2..])),
        Some(p) if !p.is_empty() => Some(PathBuf::from(p)),
        _ => None,
    }
}

fn utc_iso(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn section(md: &str, heading: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?ms)^## {}\n+(.+?)(?:\n## |\z)", regex::escape(heading))).ok()?;
    re.captures(md).map(|c| c[1].trim().to_string())
}

/// 常见 iPhone app 的中文名（没有的用 App Store 上查到的名字，见 icons.rs）
const PHONE_NAMES: &[(&str, &str)] = &[
    ("com.tencent.xin", "微信"),
    ("com.ss.iphone.ugc.Aweme", "抖音"),
    ("com.bytedance.ee.lark", "飞书"),
    ("com.tencent.weread", "微信读书"),
    ("com.xingin.discover", "小红书"),
    ("com.dragon.read", "番茄小说"),
    ("com.yadea.smartmoto", "雅迪"),
    ("com.apple.camera", "相机"),
    ("com.alipay.iphoneclient", "支付宝"),
    ("com.openai.chat", "ChatGPT"),
    ("com.apple.InCallService", "通话"),
    ("com.xiaojukeji.didi", "滴滴"),
    ("com.autonavi.amap", "高德地图"),
    ("com.apple.mobileslideshow", "照片"),
    ("com.apple.ClockAngel", "时钟"),
    ("com.tencent.ww", "企业微信"),
    ("com.apple.mobilesafari", "Safari"),
    ("com.taobao.taobao4iphone", "淘宝"),
    ("com.apple.Preferences", "设置"),
    ("com.apple.MobileSMS", "信息"),
    ("com.apple.mobilephone", "电话"),
    ("com.netease.cloudmusic", "网易云音乐"),
    ("tv.danmaku.bilianime", "哔哩哔哩"),
    ("com.anthropic.claude", "Claude"),
    ("com.apple.AppStore", "App Store"),
    ("com.apple.mobiletimer", "时钟"),
    ("com.laiwang.DingTalk", "钉钉"),
    ("com.atebits.Tweetie2", "X"),
    ("com.sina.weibo", "微博"),
    ("ph.telegra.Telegraph", "Telegram"),
];

/// iPhone 应用名：内置的常见 app，加上查图标时从 App Store 拿到的名字（Beayy/icons/ios/<id>.name）
fn app_names() -> HashMap<String, String> {
    let mut m: HashMap<String, String> = PHONE_NAMES.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if let Ok(it) = fs::read_dir(default_root().join("icons/ios")) {
        for f in it.filter_map(|e| e.ok()) {
            let n = f.file_name().to_string_lossy().to_string();
            if let Some(id) = n.strip_suffix(".name") {
                if let Ok(name) = fs::read_to_string(f.path()) {
                    if !name.trim().is_empty() {
                        m.entry(id.to_string()).or_insert_with(|| name.trim().to_string());
                    }
                }
            }
        }
    }
    m
}

// ---------- iPhone ----------

struct PhoneEv {
    t: f64,
    start: bool,
    bundle: String,
}

/// iPhone 记录要读 2 千多个分段文件（约 1 秒），app 里缓存 60 秒；新同步来的记录最多晚 1 分钟出现在页面上
fn phone_events() -> std::sync::Arc<Vec<PhoneEv>> {
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<Option<(Instant, Arc<Vec<PhoneEv>>)>>> = OnceLock::new();
    let mut g = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some((t, v)) = g.as_ref() {
        if t.elapsed() < Duration::from_secs(60) {
            return v.clone();
        }
    }
    let v = Arc::new(read_phone_events());
    *g = Some((Instant::now(), v.clone()));
    v
}

fn read_phone_events() -> Vec<PhoneEv> {
    let mut out = Vec::new();
    let devices = default_root().join("devices");
    let Ok(devs) = fs::read_dir(&devices) else { return out };
    for dev in devs.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("iphone-")) {
        let Ok(segs) = fs::read_dir(dev.path().join("segments")) else { continue };
        for seg in segs.filter_map(|e| e.ok()) {
            let Ok(bytes) = fs::read(seg.path().join("events.jsonl")) else { continue };
            for line in String::from_utf8_lossy(&bytes).lines() {
                let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
                if e["event_type"] == "app.focus" {
                    if let (Some(t), Some(b)) = (e["biome_time"].as_f64(), e["bundle_id"].as_str()) {
                        out.push(PhoneEv { t, start: e["state"] == "start", bundle: b.into() });
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    out
}

fn day_bounds(date: NaiveDate) -> (DateTime<Local>, DateTime<Local>) {
    let s = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap()).unwrap();
    (s, s + Duration::days(1))
}

fn phone_day(ev: &[PhoneEv], date: NaiveDate, names: &HashMap<String, String>) -> Option<Value> {
    if ev.is_empty() {
        return None;
    }
    let (s, e) = day_bounds(date);
    let (s0, e0) = (s.timestamp() as f64, e.timestamp() as f64);
    let stop = (s + Duration::hours(HARD_STOP as i64)).timestamp() as f64;
    let dawn_end = (s + Duration::hours(5)).timestamp() as f64;
    let synced = ev.iter().map(|x| x.t).fold(f64::MIN, f64::max);
    let mut spans: Vec<(f64, f64, String)> = Vec::new();
    let mut opened: HashMap<&str, f64> = HashMap::new();
    // 事件已按时间排好：只看当天前 1 天到当天结束这一段（跨午夜的前台区间要从前一天开始配对），不必每天扫全部记录
    let lo = ev.partition_point(|x| x.t < s0 - 86_400.0);
    let hi = ev.partition_point(|x| x.t <= e0 + 86_400.0);
    for x in &ev[lo..hi] {
        if x.start {
            opened.insert(&x.bundle, x.t);
        } else if let Some(a) = opened.remove(x.bundle.as_str()) {
            if x.t > s0 && a < e0 {
                spans.push((a.max(s0), x.t.min(e0), x.bundle.clone()));
            }
        }
    }
    spans.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let mut pickups = 0;
    let mut last_end: Option<f64> = None;
    for (a, z, _) in &spans {
        if last_end.map(|l| a - l > PICKUP_GAP).unwrap_or(true) {
            pickups += 1;
        }
        last_end = Some(last_end.map(|l| l.max(*z)).unwrap_or(*z));
    }
    let used: Vec<&(f64, f64, String)> = spans.iter().filter(|x| x.2 != LOCK_ID).collect();
    let mut by_app: HashMap<&str, f64> = HashMap::new();
    let mut hours: BTreeMap<String, f64> = BTreeMap::new();
    for (a, z, b) in &used {
        *by_app.entry(b.as_str()).or_default() += z - a;
        let h = Local.timestamp_opt(*a as i64, 0).unwrap().hour();
        *hours.entry(format!("{h:02}")).or_default() += z - a;
    }
    let sessions = phone_sessions(&used, names);
    let mut apps: Vec<(&str, f64)> = by_app.into_iter().filter(|(_, v)| *v >= 60.0).collect();
    apps.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    Some(json!({
        "total_sec": used.iter().map(|(a, z, _)| z - a).sum::<f64>().round() as i64,
        "pickups": pickups,
        "late_sec": used.iter().filter(|(_, z, _)| *z > stop).map(|(a, z, _)| z - a.max(stop)).sum::<f64>().round() as i64,
        "night_sec": used.iter().filter(|(a, _, _)| *a < dawn_end).map(|(a, z, _)| z.min(dawn_end) - a).sum::<f64>().round() as i64,
        "apps": apps.iter().take(15).map(|(b, v)| json!({"bundle_id": b, "name": names.get(*b).cloned().unwrap_or_else(|| b.to_string()), "sec": v.round() as i64})).collect::<Vec<_>>(),
        "hours": hours.into_iter().map(|(k, v)| (k, json!(v.round() as i64))).collect::<Map<_, _>>(),
        "synced_until": utc_iso(Utc.timestamp_opt(synced as i64, 0).unwrap()),
        "sessions": sessions,
    }))
}

/// 不到这么久的拿起算「零碎」：连着的几次合成一行
const BRIEF_SEC: f64 = 60.0;
/// 零碎拿起之间隔超过这么久就不再合并
const BRIEF_JOIN_GAP: f64 = 15.0 * 60.0;

/// 手机时间线：一次拿起一行（前后两段前台之间空超过 PICKUP_GAP 算新的一次，同「拿起次数」）。
/// 每行：起止、总秒数、各 app 秒数（多到少）。不到 1 分钟的零碎拿起，连着的合成一行（kind＝brief，count＝几次）
fn phone_sessions(used: &[&(f64, f64, String)], names: &HashMap<String, String>) -> Vec<Value> {
    struct Sess {
        a: f64,
        z: f64,
        sec: f64,
        count: usize,
        apps: Vec<(String, f64)>,
        /// 合进来的每一次都不到 BRIEF_SEC
        small: bool,
    }
    let mut out: Vec<Sess> = vec![];
    for (a, z, b) in used {
        let new = out.last().map(|l| a - l.z > PICKUP_GAP).unwrap_or(true);
        if new {
            out.push(Sess { a: *a, z: *z, sec: 0.0, count: 1, apps: vec![], small: true });
        }
        let cur = out.last_mut().unwrap();
        cur.z = cur.z.max(*z);
        cur.sec += z - a;
        match cur.apps.iter_mut().find(|(x, _)| x == b) {
            Some(x) => x.1 += z - a,
            None => cur.apps.push((b.clone(), z - a)),
        }
    }
    for x in out.iter_mut() {
        x.small = x.sec < BRIEF_SEC;
    }
    // 零碎拿起合并
    let mut merged: Vec<Sess> = vec![];
    for x in out {
        if let Some(l) = merged.last_mut() {
            if x.small && l.small && x.a - l.z < BRIEF_JOIN_GAP {
                l.z = x.z;
                l.sec += x.sec;
                l.count += x.count;
                for (b, v) in x.apps {
                    match l.apps.iter_mut().find(|(y, _)| *y == b) {
                        Some(y) => y.1 += v,
                        None => l.apps.push((b, v)),
                    }
                }
                continue;
            }
        }
        merged.push(x);
    }
    merged
        .into_iter()
        .map(|mut x| {
            x.apps.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
            json!({
                "start": utc_iso(Utc.timestamp_opt(x.a as i64, 0).unwrap()),
                "end": utc_iso(Utc.timestamp_opt(x.z.ceil() as i64, 0).unwrap()),
                "sec": x.sec.round() as i64,
                "kind": if x.count > 1 { "brief" } else { "session" },
                "count": x.count,
                "apps": x.apps.iter().map(|(b, v)| json!({"bundle_id": b, "name": names.get(b).cloned().unwrap_or_else(|| b.clone()), "sec": v.round() as i64})).collect::<Vec<_>>(),
            })
        })
        .collect()
}

// ---------- 摘要 ----------

fn self_segments() -> HashMap<String, Vec<Value>> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    // 项目名按别名表归到规范名，领域按登记表固定（同一个项目前后一致）
    let sm = beayy_summary::Summarizer::new(default_root());
    let (aliases, domains) = (sm.aliases(), sm.domains());
    let canon = |parts: Option<&Value>| -> Value {
        Value::Array(
            parts
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut x| {
                    let p = x["project"].as_str().unwrap_or("").to_string();
                    let p = aliases.get(&p).cloned().unwrap_or(p);
                    if let Some(d) = domains.get(&p) {
                        x["domain"] = json!(d);
                    }
                    x["project"] = json!(p);
                    // 旧分类名（开发、会议……）也归到现在的二级类型
                    let act = beayy_summary::canon_activity(x["activity"].as_str().unwrap_or(""));
                    x["activity"] = json!(act);
                    x
                })
                .collect(),
        )
    };
    let Ok(files) = fs::read_dir(default_root().join("summaries")) else { return out };
    let mut files: Vec<PathBuf> = files.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    files.sort();
    let front_re = Regex::new(r"(?m)^(title|description|applications): (.*)$").unwrap();
    let mem_re = Regex::new(r"(?ms)^## Memory summary\n+(.+?)(?:\n#|\z)").unwrap();
    let ctx_re = Regex::new(r"(?ms)^### Important non-obvious context about the user\n+(.+?)(?:\n#|\z)").unwrap();
    let rec_re = Regex::new(r"(?ms)^## Recording summary\n+(.+?)(?:\n## |\z)").unwrap();
    for f in files {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with("-memory-summary.md") || name.len() < 19 {
            continue;
        }
        let Ok(start) = chrono::NaiveDateTime::parse_from_str(&name[..19], "%Y-%m-%dT%H-%M-%S") else { continue };
        let start = Utc.from_utc_datetime(&start);
        let six = name.contains("-6h-");
        let end = start + if six { Duration::hours(6) } else { Duration::minutes(10) };
        let md = fs::read_to_string(&f).unwrap_or_default();
        let head = md.split("\n---").next().unwrap_or("");
        let front: HashMap<String, String> = front_re.captures_iter(head).map(|c| (c[1].to_string(), c[2].to_string())).collect();
        let ctx: Vec<String> = ctx_re
            .captures(&md)
            .map(|c| c[1].lines().filter(|l| l.starts_with("- ")).map(|l| l[2..].trim().to_string()).collect())
            .unwrap_or_default();
        let date = start.with_timezone(&Local).format("%Y-%m-%d").to_string();
        let fm = beayy_summary::front(&md);
        out.entry(date).or_default().push(json!({
            "active_sec": fm.get("active_sec").cloned().unwrap_or(Value::Null),
            "parts": canon(fm.get("parts")),
            "start": utc_iso(start), "end": utc_iso(end), "kind": if six { "6h" } else { "10min" }, "source": "beayy",
            "title": front.get("title").cloned().unwrap_or_default(),
            "apps": front.get("applications").map(|a| a.trim_matches(|c| c == '[' || c == ']').split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect::<Vec<_>>()).unwrap_or_default(),
            "description": front.get("description").cloned().unwrap_or_default(),
            "memory": mem_re.captures(&md).map(|c| c[1].trim().to_string()).unwrap_or_default(),
            "context": ctx,
            "recording": rec_re.captures(&md).map(|c| c[1].trim().to_string()).unwrap_or_default(),
        }));
    }
    out
}

fn local_at(date: NaiveDate, hhmm: &str, after: Option<DateTime<Local>>) -> Option<DateTime<Local>> {
    let t = chrono::NaiveTime::parse_from_str(hhmm, "%H:%M").ok()?;
    let mut dt = Local.from_local_datetime(&date.and_time(t)).single()?;
    if let Some(a) = after {
        if dt <= a {
            dt += Duration::days(1);
        }
    }
    Some(dt)
}

fn codex_segments(pack: &Value, date: NaiveDate) -> Vec<Value> {
    let mut out = Vec::new();
    for x in pack["codex"].as_array().cloned().unwrap_or_default() {
        let (Some(a), Some(z0)) = (x["start"].as_str(), x["end"].as_str()) else { continue };
        let Some(a) = local_at(date, a, None) else { continue };
        let Some(z) = local_at(date, z0, Some(a)) else { continue };
        out.push(json!({
            "start": utc_iso(a.with_timezone(&Utc)), "end": utc_iso(z.with_timezone(&Utc)),
            "kind": x["kind"].as_str().unwrap_or("10min"), "source": "codex",
            "title": x["title"], "description": x["description"], "memory": x["memory"],
            "context": x.get("context").cloned().unwrap_or(json!([])), "recording": x["recording"],
        }));
    }
    out
}

// ---------- 电脑：实时（自采事件） ----------

/// 某天的电脑活动，直接从自采事件算（数据包每晚 20:55 才生成，白天页面要用这个）。缓存 60 秒
pub fn live_computer(date: NaiveDate) -> Option<Value> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static CACHE: OnceLock<Mutex<HashMap<NaiveDate, (Instant, Option<Value>)>>> = OnceLock::new();
    let mut g = CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    if let Some((t, v)) = g.get(&date) {
        if t.elapsed().as_secs() < 60 {
            return v.clone();
        }
    }
    // 过去的日子不会再变：算一次存盘（Beayy/daily/stats_YYYY-MM-DD.json），之后直接读
    let cache = default_root().join("daily").join(format!("stats_{date}.json"));
    let past = date < Local::now().date_naive();
    let v = match fs::read_to_string(&cache).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(v) if past => Some(v).filter(|v| !v.is_null()),
        _ => {
            let v = compute_live(date);
            if past {
                let _ = fs::create_dir_all(cache.parent().unwrap());
                let _ = fs::write(&cache, serde_json::to_string(&v).unwrap_or_default());
            }
            v
        }
    };
    g.insert(date, (Instant::now(), v.clone()));
    v
}

fn compute_live(date: NaiveDate) -> Option<Value> {
    let (s, e) = day_bounds(date);
    let act = beayy_summary::Summarizer::new(default_root()).activity(s.with_timezone(&Utc), e.with_timezone(&Utc));
    if act.spans.is_empty() && act.windows.is_empty() {
        return None;
    }
    let secs = |a: DateTime<Utc>, b: DateTime<Utc>| (b - a).num_milliseconds() as f64 / 1000.0;
    let mut hours: BTreeMap<String, f64> = BTreeMap::new();
    for (a, b) in &act.spans {
        // 按小时切开
        let mut t = *a;
        while t < *b {
            let lt = t.with_timezone(&Local);
            let next = (lt + Duration::hours(1)).with_minute(0).and_then(|x| x.with_second(0)).map(|x| x.with_timezone(&Utc)).unwrap_or(*b).min(*b);
            *hours.entry(format!("{:02}", lt.hour())).or_default() += secs(t, next);
            t = next;
        }
    }
    let mut apps: Vec<(String, String, f64)> = vec![];
    for (a, b, name, bundle) in &act.windows {
        match apps.iter_mut().find(|x| x.0 == *name) {
            Some(x) => x.2 += secs(*a, *b),
            None => apps.push((name.clone(), bundle.clone(), secs(*a, *b))),
        }
    }
    apps.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap());
    let hm = |t: &DateTime<Utc>| t.with_timezone(&Local).format("%H:%M").to_string();
    Some(json!({
        "active_sec": act.spans.iter().map(|(a, b)| secs(*a, *b)).sum::<f64>().round() as i64,
        "first": act.spans.first().map(|x| hm(&x.0)),
        "last": act.spans.last().map(|x| hm(&x.1)),
        "switches": act.switches,
        "active_hours": hours.into_iter().map(|(k, v)| (k, json!(v.round() as i64))).collect::<Map<_, _>>(),
        "spans": act.spans.iter().map(|(a, b)| json!([utc_iso(*a), utc_iso(*b)])).collect::<Vec<_>>(),
        "apps": apps.iter().take(20).map(|(n, b, v)| json!({"name": n, "bundle_id": b, "sec": v.round() as i64})).collect::<Vec<_>>(),
    }))
}

// ---------- 命令 ----------

fn pack_of(repo: &Option<PathBuf>, date: &str) -> Option<Value> {
    let p = repo.as_ref()?.join("日数据").join(format!("日数据_{}.json", date.replace('-', "")));
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn summary_of(repo: &Option<PathBuf>, date: &str) -> Option<String> {
    // 外部目录里有就用它的；没有就用 app 自己写的（Beayy/daily/）
    let name = format!("日总结_{}.md", date.replace('-', ""));
    repo.as_ref()
        .and_then(|r| fs::read_to_string(r.join("日总结").join(&name)).ok())
        .or_else(|| fs::read_to_string(default_root().join("daily").join(&name)).ok())
}

fn computer_hours(c: &Value) -> Value {
    if let Some(h) = c.get("active_hours").and_then(|v| v.as_object()) {
        return Value::Object(h.iter().map(|(k, v)| (k.clone(), json!(v.as_f64().unwrap_or(0.0).round() as i64))).collect());
    }
    let mut m = Map::new();
    if let Some(h) = c.get("hours").and_then(|v| v.as_object()) {
        for (k, v) in h {
            let s: f64 = v.as_object().map(|o| o.values().filter_map(|x| x.as_f64()).sum()).unwrap_or(0.0);
            m.insert(k.clone(), json!(s.round() as i64));
        }
    }
    Value::Object(m)
}

#[tauri::command]
pub fn list_days() -> Vec<Value> {
    let repo = repo_path();
    let names = app_names();
    let ev = phone_events();
    let mine = self_segments();
    let mut dates: HashSet<String> = mine.keys().cloned().collect();
    if let Some(Ok(it)) = repo.as_ref().map(|r| fs::read_dir(r.join("日数据"))) {
        for e in it.filter_map(|e| e.ok()) {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(d) = n.strip_prefix("日数据_").and_then(|s| s.strip_suffix(".json")) {
                if d.len() == 8 {
                    dates.insert(format!("{}-{}-{}", &d[..4], &d[4..6], &d[6..]));
                }
            }
        }
    }
    let mut dates: Vec<String> = dates.into_iter().collect();
    dates.sort_by(|a, b| b.cmp(a));
    dates
        .iter()
        .map(|date| {
            let pack = pack_of(&repo, date);
            let md = summary_of(&repo, date);
            let nd = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
            let phone = phone_day(&ev, nd, &names);
            let mut c = pack.as_ref().map(|p| p["computer"].clone()).unwrap_or(Value::Null);
            // 还没有数据包的那天（通常是今天）：电脑用自采事件实时算
            if c.get("active_sec").map(Value::is_null).unwrap_or(true) {
                if let Some(l) = live_computer(nd) {
                    c = l;
                }
            }
            let pp = pack.as_ref().map(|p| p["phone"].clone()).unwrap_or(Value::Null);
            json!({
                "date": date,
                "line": md.as_deref().and_then(|m| section(m, "今天的一句话")),
                "active_sec": c.get("active_sec").cloned().unwrap_or(Value::Null),
                "phone_sec": phone.as_ref().map(|p| p["total_sec"].clone()).unwrap_or_else(|| pp.get("total_sec").cloned().unwrap_or(Value::Null)),
                "hc": if c.is_null() { json!({}) } else { computer_hours(&c) },
                "hp": phone.as_ref().map(|p| p["hours"].clone()).unwrap_or_else(|| pp.get("hours").cloned().unwrap_or(json!({}))),
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_day(date: String) -> Value {
    let repo = repo_path();
    let Ok(nd) = NaiveDate::parse_from_str(&date, "%Y-%m-%d") else { return Value::Null };
    let pack = pack_of(&repo, &date);
    let own = self_segments().remove(&date).unwrap_or_default();
    let live = if pack.as_ref().map(|p| p["computer"]["active_sec"].is_null() || p["partial"] == true).unwrap_or(true) || date == Local::now().format("%Y-%m-%d").to_string() {
        live_computer(nd)
    } else {
        None
    };
    let taken: HashSet<String> = own.iter().filter_map(|s| s["start"].as_str().map(String::from)).collect();
    let mut segs: Vec<Value> = pack.as_ref().map(|p| codex_segments(p, nd)).unwrap_or_default();
    segs.retain(|s| !taken.contains(s["start"].as_str().unwrap_or("")));
    segs.extend(own);
    segs.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    let work = work_of(&segs);
    let hours = rollups_of(nd);
    let segs = merge_idle(segs);
    json!({
        "date": date,
        "pack": pack,
        "summary_md": summary_of(&repo, &date),
        "live": live,
        "work": work,
        "hours": hours,
        "segments": segs,
        "phone": phone_day(phone_events().as_slice(), nd, &app_names()),
    })
}

/// 时间花在哪：10 分钟摘要的 parts（类型、项目、占比）× 这段在电脑前的秒数，按项目、按类型累计；项目名按别名表归并
fn work_of(segs: &[Value]) -> Value {
    // 一级 → 二级 → 秒
    let mut acts: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let mut doms: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    let (mut tagged, mut untagged) = (0f64, 0f64);
    for sg in segs {
        let sec = sg["active_sec"].as_f64().unwrap_or(0.0);
        let parts = sg["parts"].as_array().cloned().unwrap_or_default();
        if parts.is_empty() {
            untagged += sec;
            continue;
        }
        tagged += sec;
        for x in parts {
            let v = sec * x["share"].as_f64().unwrap_or(0.0);
            let act = x["activity"].as_str().unwrap_or("其他");
            let group = beayy_summary::activity_group(act);
            let child = if act == group && act != "其他" { "未细分" } else { act };
            *acts.entry(group.to_string()).or_default().entry(child.to_string()).or_default() += v;
            let pj = x["project"].as_str().unwrap_or("");
            let dom = x["domain"].as_str().unwrap_or("工作");
            *doms.entry(dom.to_string()).or_default().entry(if pj.is_empty() { "未归项目".into() } else { pj.to_string() }).or_default() += v;
        }
    }
    let tree = |m: BTreeMap<String, BTreeMap<String, f64>>| {
        let mut v: Vec<Value> = m
            .into_iter()
            .map(|(k, kids)| {
                let total: f64 = kids.values().sum();
                let mut c: Vec<(String, f64)> = kids.into_iter().filter(|x| x.1 >= 30.0).collect();
                c.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                json!({"name": k, "sec": total.round() as i64, "children": c.into_iter().map(|(n, s)| json!({"name": n, "sec": s.round() as i64})).collect::<Vec<_>>()})
            })
            .filter(|x| x["sec"].as_i64().unwrap_or(0) >= 30)
            .collect();
        v.sort_by(|a, b| b["sec"].as_i64().cmp(&a["sec"].as_i64()));
        v
    };
    json!({"activities": tree(acts), "domains": tree(doms), "tagged_sec": tagged.round() as i64, "untagged_sec": untagged.round() as i64})
}

/// 这一天的小时摘要（Beayy/summaries-1h/），项目名按别名表归并
fn rollups_of(date: NaiveDate) -> Vec<Value> {
    let (s, e) = day_bounds(date);
    let al = beayy_summary::Summarizer::new(default_root()).aliases();
    let mut out = vec![];
    for f in fs::read_dir(default_root().join("summaries-1h")).map(|r| r.filter_map(|x| x.ok()).map(|x| x.path()).collect::<Vec<_>>()).unwrap_or_default() {
        let n = f.file_name().unwrap().to_string_lossy().to_string();
        let Ok(t) = chrono::NaiveDateTime::parse_from_str(n.get(..19).unwrap_or(""), "%Y-%m-%dT%H-%M-%S") else { continue };
        let t = t.and_utc();
        if t < s.with_timezone(&Utc) || t >= e.with_timezone(&Utc) {
            continue;
        }
        let fm = beayy_summary::front(&fs::read_to_string(&f).unwrap_or_default());
        let parts: Vec<Value> = fm
            .get("parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut x| {
                if let Some(c) = x["project"].as_str().and_then(|p| al.get(p)) {
                    x["project"] = json!(c);
                }
                x
            })
            .collect();
        out.push(json!({
            "start": utc_iso(t), "end": utc_iso(t + Duration::hours(1)),
            "title": fm.get("title"), "description": fm.get("description"),
            "active_sec": fm.get("active_sec"), "parts": parts,
        }));
    }
    out.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    out
}

/// 连续的「不在电脑前」段（自采、首尾相接）合成一段，kind＝idle
fn merge_idle(segs: Vec<Value>) -> Vec<Value> {
    let idle = |s: &Value| s["source"] == "beayy" && s["title"] == beayy_summary::IDLE_TITLE;
    let mut out: Vec<Value> = Vec::new();
    for s in segs {
        if idle(&s) {
            if let Some(last) = out.last_mut() {
                if last["kind"] == "idle" && last["end"] == s["start"] {
                    last["end"] = s["end"].clone();
                    continue;
                }
            }
            out.push(json!({"start": s["start"], "end": s["end"], "kind": "idle", "source": "beayy",
                "title": beayy_summary::IDLE_TITLE, "description": "", "memory": "", "context": [], "recording": ""}));
        } else {
            out.push(s);
        }
    }
    out
}

fn rules_path() -> PathBuf {
    default_root().join("rules.json")
}

#[tauri::command]
pub fn get_rules() -> Value {
    fs::read_to_string(rules_path()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!([]))
}

#[tauri::command]
pub fn save_rules(rules: Value) -> Result<(), String> {
    fs::create_dir_all(default_root()).map_err(|e| e.to_string())?;
    fs::write(rules_path(), serde_json::to_string_pretty(&rules).unwrap()).map_err(|e| e.to_string())
}


/// settings.json 的键沿用 Python 摘要脚本的叫法（summary_model、daily_model、blacklist），对网页换成 COMMANDS.md 的叫法
#[tauri::command]
pub fn get_settings() -> Value {
    let s = read_settings_raw();
    let get = |k: &str, d: &str| s.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).unwrap_or(d).to_string();
    json!({
        "gateway": get("gateway", "https://api.openai.com/v1"),
        "model_segment": get("summary_model", ""),
        "model_daily": get("daily_model", ""),
        "repo_path": get("repo_path", ""),
        "onboarded": s.get("onboarded").and_then(Value::as_bool).unwrap_or(false),
        "blocklist": s.get("blacklist").cloned().unwrap_or(json!(["com.1password.1password"])),
        "has_api_key": beayy_summary::api_key_source().is_some(),
        "api_key_source": beayy_summary::api_key_source(),
    })
}

#[tauri::command]
pub fn save_settings(settings: Value) -> Result<(), String> {
    let mut s = read_settings_raw();
    let map = [("gateway", "gateway"), ("model_segment", "summary_model"), ("model_daily", "daily_model"), ("repo_path", "repo_path"), ("blocklist", "blacklist"), ("onboarded", "onboarded")];
    for (from, to) in map {
        if let Some(v) = settings.get(from) {
            s.insert(to.into(), v.clone());
        }
    }
    fs::create_dir_all(default_root()).map_err(|e| e.to_string())?;
    fs::write(settings_path(), serde_json::to_string_pretty(&Value::Object(s)).unwrap()).map_err(|e| e.to_string())
}

/// 密钥写进钥匙串（服务 com.fengli.beayy，账号 api_key），不落盘、不回传网页
#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    let ok = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-U", "-s", "com.fengli.beayy", "-a", "api_key", "-w", &key])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok { Ok(()) } else { Err("写入钥匙串失败".into()) }
}

// ---------- 删除记录 ----------

/// 删掉本机电脑事件里某时刻之后的记录，连同这些分段的 10 分钟摘要（摘要下一轮按剩下的事件重写）。
/// 只动本机（mac-*）的事件；iPhone 记录、已经归档进仓库 raw/ 的不动。返回删掉的条数
#[tauri::command]
pub fn delete_since(minutes: Option<i64>, today: Option<bool>) -> Result<usize, String> {
    let from: DateTime<Utc> = if today == Some(true) {
        day_bounds(Local::now().date_naive()).0.with_timezone(&Utc)
    } else {
        Utc::now() - Duration::minutes(minutes.unwrap_or(60).clamp(1, 24 * 60))
    };
    let first_seg = from - Duration::minutes(10);
    let mut removed = 0;
    let mut touched: Vec<String> = vec![];
    let Ok(devs) = fs::read_dir(default_root().join("devices")) else { return Ok(0) };
    for dev in devs.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("mac-")) {
        let Ok(segs) = fs::read_dir(dev.path().join("segments")) else { continue };
        for seg in segs.filter_map(|e| e.ok()) {
            let name = seg.file_name().to_string_lossy().to_string();
            let Ok(t) = chrono::NaiveDateTime::parse_from_str(&name, "%Y-%m-%dT%H-%M-%SZ") else { continue };
            if t.and_utc() < first_seg {
                continue;
            }
            let f = seg.path().join("events.jsonl");
            let Ok(bytes) = fs::read(&f) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            let mut keep = String::new();
            let mut n = 0;
            for line in text.lines() {
                let t = serde_json::from_str::<Value>(line).ok().and_then(|e| e["timestamp"].as_str().and_then(|x| DateTime::parse_from_rfc3339(x).ok()));
                match t {
                    Some(t) if t.with_timezone(&Utc) >= from => n += 1,
                    _ => {
                        keep.push_str(line);
                        keep.push('\n');
                    }
                }
            }
            if n > 0 {
                // 原地重写（不能换文件：采集线程开着这个文件在追加）
                fs::write(&f, keep).map_err(|e| e.to_string())?;
                removed += n;
                touched.push(name);
            }
        }
    }
    if let Ok(files) = fs::read_dir(default_root().join("summaries")) {
        for f in files.filter_map(|e| e.ok()) {
            let n = f.file_name().to_string_lossy().to_string();
            if touched.iter().any(|t| n.starts_with(t.trim_end_matches('Z'))) {
                let _ = fs::remove_file(f.path());
            }
        }
    }
    Ok(removed)
}

// ---------- 设备 ----------

/// 数据目录里的每台设备（devices/<设备>/）：种类、是不是本机、记录从哪天开始、最近一条、条数、占用空间。缓存 60 秒
#[tauri::command]
pub fn list_devices() -> Vec<Value> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<Value>)>>> = OnceLock::new();
    let mut g = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if let Some((t, v)) = g.as_ref() {
        if t.elapsed().as_secs() < 60 {
            return v.clone();
        }
    }
    let v = read_devices();
    *g = Some((Instant::now(), v.clone()));
    v
}

fn read_devices() -> Vec<Value> {
    let me = beayy_core::local_device();
    let synced = beayy_sync::remote_set(&beayy_core::data_root());
    let mut out = vec![];
    let Ok(devs) = fs::read_dir(default_root().join("devices")) else { return out };
    let mut devs: Vec<_> = devs.filter_map(|e| e.ok()).filter(|e| e.path().is_dir()).collect();
    devs.sort_by_key(|e| e.file_name());
    for dev in devs {
        let id = dev.file_name().to_string_lossy().to_string();
        let kind = id.split('-').next().unwrap_or("other").to_string();
        let mut segs: Vec<PathBuf> = fs::read_dir(dev.path().join("segments")).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).collect()).unwrap_or_default();
        segs.sort();
        let (mut events, mut bytes) = (0u64, 0u64);
        for s in &segs {
            if let Ok(b) = fs::read(s.join("events.jsonl")) {
                bytes += b.len() as u64;
                if kind != "iphone" {
                    events += b.iter().filter(|c| **c == b'\n').count() as u64;
                }
            }
        }
        let seg_time = |p: &PathBuf| {
            chrono::NaiveDateTime::parse_from_str(&p.file_name().unwrap().to_string_lossy(), "%Y-%m-%dT%H-%M-%SZ").ok().map(|t| t.and_utc())
        };
        let (mut first, mut last) = (segs.first().and_then(seg_time), segs.last().and_then(seg_time).map(|t| t + Duration::minutes(10)));
        if kind == "iphone" {
            // iPhone 的分段按事件发生时刻放，按事件本身算更准
            let ev = phone_events();
            events = ev.len() as u64;
            first = ev.first().and_then(|x| Utc.timestamp_opt(x.t as i64, 0).single());
            last = ev.last().and_then(|x| Utc.timestamp_opt(x.t as i64, 0).single());
        }
        let name = match kind.as_str() {
            "mac" => format!("Mac · {}", &id[4..]),
            "iphone" => format!("iPhone · {}", &id[7..]),
            "win" => format!("Windows · {}", &id[4..]),
            _ => id.clone(),
        };
        out.push(json!({
            "synced": synced.contains(&id),
            "id": id, "kind": kind, "name": name, "this": id == me,
            "first": first.map(utc_iso), "last": last.map(utc_iso),
            "events": events, "bytes": bytes,
        }));
    }
    // 本机排第一
    out.sort_by_key(|d| !d["this"].as_bool().unwrap_or(false));
    out
}

// ---------- 头像和名称 ----------

/// 本机存的显示名称和头像（settings.json 的 profile_*）；没设名称时用账号邮箱 @ 前面那段，再没有就「我」
#[tauri::command]
pub fn get_profile() -> Value {
    let s = read_settings_raw();
    let email = beayy_sync::load(&beayy_core::data_root()).and_then(|a| a.email);
    let name = s.get("profile_name").and_then(Value::as_str).filter(|x| !x.is_empty()).map(String::from)
        .or_else(|| email.as_ref().map(|e| e.split('@').next().unwrap_or("").to_string()))
        .unwrap_or_else(|| "我".into());
    json!({"name": name, "avatar": s.get("profile_avatar").cloned().unwrap_or(Value::Null), "email": email})
}

pub fn write_profile(name: &str, avatar: Option<&str>, updated: i64) -> Result<(), String> {
    let mut s = read_settings_raw();
    s.insert("profile_name".into(), json!(name.trim()));
    s.insert("profile_avatar".into(), avatar.map(|a| json!(a)).unwrap_or(Value::Null));
    s.insert("profile_updated".into(), json!(updated));
    fs::create_dir_all(default_root()).map_err(|e| e.to_string())?;
    fs::write(settings_path(), serde_json::to_string_pretty(&Value::Object(s)).unwrap()).map_err(|e| e.to_string())
}

pub fn profile_updated() -> i64 {
    read_settings_raw().get("profile_updated").and_then(Value::as_i64).unwrap_or(0)
}

/// 改名称和头像：先存本机；登录着就同时存到账号上（换设备登录也是这个头像和名字）
#[tauri::command]
pub async fn save_profile(name: String, avatar: Option<String>) -> Result<(), String> {
    if let Some(a) = &avatar {
        if !a.starts_with("data:image/") || a.len() > 300_000 {
            return Err("头像要是图片，且压缩后不超过 300KB".into());
        }
    }
    let name: String = name.trim().chars().take(40).collect();
    let root = beayy_core::data_root();
    let updated = if beayy_sync::load(&root).map(|a| a.email.is_some()).unwrap_or(false) {
        beayy_sync::set_profile(&root, &name, avatar.as_deref())?
    } else {
        Utc::now().timestamp_millis()
    };
    write_profile(&name, avatar.as_deref(), updated)
}

// ---------- 项目（领域 · 项目） ----------

/// 所有出现过的项目：规范名、领域、累计时长、最近一次、被合并进来的别名
#[tauri::command]
pub fn list_projects() -> Vec<Value> {
    let sm = beayy_summary::Summarizer::new(default_root());
    let aliases = sm.aliases();
    let mut agg: BTreeMap<String, (String, f64, String)> = BTreeMap::new();
    for segs in self_segments().into_values() {
        for sg in segs {
            let sec = sg["active_sec"].as_f64().unwrap_or(0.0);
            for x in sg["parts"].as_array().cloned().unwrap_or_default() {
                let p = x["project"].as_str().unwrap_or("");
                if p.is_empty() {
                    continue;
                }
                let e = agg.entry(p.to_string()).or_insert((x["domain"].as_str().unwrap_or("工作").to_string(), 0.0, String::new()));
                e.1 += sec * x["share"].as_f64().unwrap_or(0.0);
                let st = sg["start"].as_str().unwrap_or("").to_string();
                if st > e.2 {
                    e.2 = st;
                }
            }
        }
    }
    let mut out: Vec<Value> = agg
        .into_iter()
        .map(|(name, (domain, sec, last))| {
            let als: Vec<&String> = aliases.iter().filter(|(_, v)| **v == name).map(|(k, _)| k).collect();
            json!({"name": name, "domain": domain, "sec": sec.round() as i64, "last": last, "aliases": als})
        })
        .collect();
    out.sort_by(|a, b| b["sec"].as_i64().cmp(&a["sec"].as_i64()));
    out
}

#[tauri::command]
pub fn merge_project(from: String, into: String) -> Result<(), String> {
    beayy_summary::Summarizer::new(default_root()).merge_project(&from, &into)
}

#[tauri::command]
pub fn set_project_domain(project: String, domain: String) -> Result<(), String> {
    beayy_summary::Summarizer::new(default_root()).set_project_domain(&project, &domain)
}

/// 首次引导里「测试一下」：用现在的网关、模型、密钥问一句
#[tauri::command]
pub async fn test_model() -> Result<(), String> {
    beayy_summary::Summarizer::new(default_root()).ask("只返回一个 JSON 对象：{\"ok\": true}", "测试连接").map(|_| ())
}

/// 还没做过首次引导（主窗口启动时直接打开）
pub fn needs_onboarding() -> bool {
    !read_settings_raw().get("onboarded").and_then(Value::as_bool).unwrap_or(false)
}
