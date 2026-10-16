//! 日总结：app 自己用当天的数据写，不依赖外部脚本。
//! 数字（在电脑前、手机、领域和项目、类型、规矩守没守住）由代码算好填进去；模型只写一句话、做成了什么、偏离、明天。
//! 写到 Beayy/daily/日总结_YYYYMMDD.md。每天 21:30 写当天，次日 0:15 用完整的一天重写一次；页面上也可以随时生成。

use beayy_core::default_root;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

pub fn path_of(date: NaiveDate) -> PathBuf {
    default_root().join("daily").join(format!("日总结_{}.md", date.format("%Y%m%d")))
}

// ---------- 规矩：和页面上同一套识别规则 ----------

enum Rule {
    /// 几点以后不用：设备 computer／phone／any
    After { dev: &'static str, h: u32, m: u32 },
    /// 某设备每天不超过多少分钟
    Limit { dev: &'static str, minutes: f64 },
    /// 某 app 每天不超过多少分钟
    App { app: String, minutes: f64 },
}

fn parse_rule(text: &str) -> Option<Rule> {
    let t: String = text.split_whitespace().collect();
    let low = t.to_lowercase();
    let dev = if t.contains("电脑") || low.contains("mac") { "computer" } else if t.contains("手机") || low.contains("iphone") { "phone" } else { "any" };
    let after = Regex::new(r"(\d{1,2})(?:[:：点](\d{2})?)?(?:分)?(?:以后|之后|后)").unwrap();
    if let Some(c) = after.captures(&t) {
        if Regex::new(r"不|别|停|关|禁").unwrap().is_match(&t) {
            let mut h: u32 = c[1].parse().ok()?;
            if h < 12 && Regex::new(r"晚上|夜里|夜间|下午|傍晚").unwrap().is_match(&t) {
                h += 12;
            }
            return Some(Rule::After { dev, h, m: c.get(2).and_then(|x| x.as_str().parse().ok()).unwrap_or(0) });
        }
    }
    let lim = Regex::new(r"(?i)(?:不超过|少于|最多|以内|不到|≤|<=?)(\d+(?:\.\d+)?)(小时|h|分钟|min|分)").unwrap();
    if let Some(c) = lim.captures(&t) {
        let n: f64 = c[1].parse().ok()?;
        let minutes = if c[2].contains('小') || c[2].eq_ignore_ascii_case("h") { n * 60.0 } else { n };
        let subject = Regex::new(r"每天|一天|每日|不超过|少于|最多|不到").unwrap().split(&t).next().unwrap_or("").to_string();
        let subject = subject.trim_start_matches(['用', '玩', '刷', '看']).to_string();
        if dev != "any" && Regex::new(r"(?i)^(电脑|手机|mac|iphone)?$").unwrap().is_match(&subject) {
            return Some(Rule::Limit { dev, minutes });
        }
        if !subject.is_empty() {
            return Some(Rule::App { app: subject, minutes });
        }
    }
    None
}

fn secs_after(spans: &[(DateTime<Utc>, DateTime<Utc>)], from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    spans.iter().map(|(a, b)| ((*b).min(to) - (*a).max(from)).num_milliseconds().max(0) as f64 / 1000.0).sum()
}

/// 一条规矩今天守没守住：（对照说明，是否守住；None＝还没到点或算不出）
fn check(rule: &str, date: NaiveDate, day: &Value) -> (String, Option<bool>) {
    let Some(r) = parse_rule(rule) else { return ("算不出来，看下面的偏离".into(), None) };
    let live = &day["live"];
    let phone = &day["phone"];
    let iso = |v: &Value| v.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc));
    let start = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap()).unwrap().with_timezone(&Utc);
    let end = start + Duration::days(1);
    match r {
        Rule::After { dev, h, m } => {
            let from = start + Duration::minutes((h * 60 + m) as i64);
            if Utc::now() < from {
                return (format!("还没到 {h:02}:{m:02}"), None);
            }
            let mut sec = 0.0;
            if dev != "phone" {
                let spans: Vec<_> = live["spans"].as_array().cloned().unwrap_or_default().iter().filter_map(|x| Some((iso(&x[0])?, iso(&x[1])?))).collect();
                sec += secs_after(&spans, from, end);
            }
            if dev != "computer" {
                for x in phone["sessions"].as_array().cloned().unwrap_or_default() {
                    if let (Some(a), Some(b)) = (iso(&x["start"]), iso(&x["end"])) {
                        let span = (b - a).num_seconds().max(1) as f64;
                        sec += secs_after(&[(a, b)], from, end) / span * x["sec"].as_f64().unwrap_or(0.0);
                    }
                }
            }
            (format!("{h:02}:{m:02} 以后用了 {} 分钟", (sec / 60.0).round()), Some(sec < 60.0))
        }
        Rule::Limit { dev, minutes } => {
            let sec = if dev == "phone" { phone["total_sec"].as_f64().unwrap_or(0.0) } else { live["active_sec"].as_f64().unwrap_or(0.0) };
            (format!("{} {:.1} 小时 / 上限 {:.1} 小时", if dev == "phone" { "手机" } else { "电脑" }, sec / 3600.0, minutes / 60.0), Some(sec <= minutes * 60.0))
        }
        Rule::App { app, minutes } => {
            let key = app.to_lowercase();
            let hit = |x: &Value| x["name"].as_str().unwrap_or("").to_lowercase().contains(&key) || x["bundle_id"].as_str().unwrap_or("").to_lowercase().contains(&key);
            let mut sec = 0.0;
            for s in phone["sessions"].as_array().cloned().unwrap_or_default() {
                for a in s["apps"].as_array().cloned().unwrap_or_default() {
                    if hit(&a) {
                        sec += a["sec"].as_f64().unwrap_or(0.0);
                    }
                }
            }
            for a in live["apps"].as_array().cloned().unwrap_or_default() {
                if hit(&a) {
                    sec += a["sec"].as_f64().unwrap_or(0.0);
                }
            }
            (format!("{app} {} 分钟 / 上限 {} 分钟", (sec / 60.0).round(), minutes), Some(sec <= minutes * 60.0))
        }
    }
}

const PROMPT: &str = "你是用户的日记助手。下面是用户今天的记录：电脑和手机的时长、时间花在哪些领域和项目、每小时在做什么、自己定的规矩今天的对照结果。
据此写今天的日总结，全部用中文，用第二人称「你」，写得具体、平实，不夸、不说教。只写材料里有的事，不编造，不写材料里没有的数字。
只返回一个 JSON 对象，不要代码块，字段：
  line: 今天的一句话，30 字以内，抓住今天最主要的事和状态
  done: 2–5 条字符串，今天做成或推进了什么（写结果，不写过程）
  drift: 0–3 条字符串，偏离：没守住的规矩、熬夜、时间明显被不重要的事占掉；没有就空数组
  tomorrow: 1–3 条字符串，明天最值得做的事，从今天没做完的里挑
";

fn dur(sec: f64) -> String {
    if sec < 3600.0 {
        format!("{} 分钟", (sec / 60.0).round())
    } else {
        format!("{:.1} 小时", sec / 3600.0)
    }
}

/// 写某天的日总结；返回 Markdown
pub fn generate(date: NaiveDate) -> Result<String, String> {
    let day = crate::data::get_day(date.format("%Y-%m-%d").to_string());
    let live = &day["live"];
    let phone = &day["phone"];
    let work = &day["work"];
    if live.is_null() && phone.is_null() {
        return Err("这一天没有记录".into());
    }
    // 代码算的数字
    let mut stats = vec![];
    if let Some(sec) = live["active_sec"].as_f64() {
        stats.push(format!("在电脑前 {}（{}–{}），切换 app {} 次", dur(sec), live["first"].as_str().unwrap_or(""), live["last"].as_str().unwrap_or(""), live["switches"]));
    }
    if let Some(sec) = phone["total_sec"].as_f64() {
        let top: Vec<String> = phone["apps"].as_array().cloned().unwrap_or_default().iter().take(3).map(|a| format!("{} {}", a["name"].as_str().unwrap_or(""), dur(a["sec"].as_f64().unwrap_or(0.0)))).collect();
        stats.push(format!("手机 {}，拿起 {} 次{}", dur(sec), phone["pickups"], if top.is_empty() { String::new() } else { format!("，最多的是 {}", top.join("、")) }));
    }
    let tree = |k: &str| -> Vec<String> {
        work[k].as_array().cloned().unwrap_or_default().iter().map(|g| {
            let kids: Vec<String> = g["children"].as_array().cloned().unwrap_or_default().iter().take(4).map(|c| format!("{} {}", c["name"].as_str().unwrap_or(""), dur(c["sec"].as_f64().unwrap_or(0.0)))).collect();
            format!("{} {}（{}）", g["name"].as_str().unwrap_or(""), dur(g["sec"].as_f64().unwrap_or(0.0)), kids.join("、"))
        }).collect()
    };
    let (domains, acts) = (tree("domains"), tree("activities"));
    let rules: Vec<(String, String, Option<bool>)> = crate::data::get_rules()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|r| r["enabled"] != false)
        .map(|r| {
            let text = r["text"].as_str().unwrap_or("").to_string();
            let (desc, ok) = check(&text, date, &day);
            (text, desc, ok)
        })
        .collect();
    let hours: Vec<String> = day["hours"].as_array().cloned().unwrap_or_default().iter()
        .filter(|h| h["title"] != "不在电脑前")
        .map(|h| {
            let t = h["start"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Local).hour()).unwrap_or(0);
            format!("{t:02}:00 {}：{}", h["title"].as_str().unwrap_or(""), h["description"].as_str().unwrap_or(""))
        })
        .collect();
    // 当前这个小时还没有小时摘要：补上最近的 10 分钟摘要
    let recent: Vec<String> = day["segments"].as_array().cloned().unwrap_or_default().iter().rev().take(6)
        .filter(|s| s["kind"] == "10min" && s["source"] == "beayy")
        .map(|s| format!("{} {}：{}", s["start"].as_str().and_then(|x| DateTime::parse_from_rfc3339(x).ok()).map(|t| t.with_timezone(&Local).format("%H:%M").to_string()).unwrap_or_default(), s["title"].as_str().unwrap_or(""), s["description"].as_str().unwrap_or("")))
        .collect();

    let mut user = format!("日期：{}\n\n", date.format("%Y-%m-%d"));
    user += &format!("时长：\n- {}\n\n", stats.join("\n- "));
    if !domains.is_empty() {
        user += &format!("为了什么（领域、项目）：\n- {}\n\n在做什么（类型）：\n- {}\n\n", domains.join("\n- "), acts.join("\n- "));
    }
    if !rules.is_empty() {
        user += &format!("规矩：\n{}\n\n", rules.iter().map(|(t, d, ok)| format!("- {t}：{d}{}", match ok { Some(true) => "，守住了", Some(false) => "，没守住", None => "" })).collect::<Vec<_>>().join("\n"));
    }
    user += &format!("每小时：\n{}\n\n最近：\n{}\n", hours.join("\n"), recent.join("\n"));
    let sm = beayy_summary::Summarizer::new(default_root());
    let j = sm.ask(PROMPT, &user)?;
    let list = |k: &str| -> String {
        let v: Vec<String> = j.get(k).and_then(Value::as_array).cloned().unwrap_or_default().iter().filter_map(|x| x.as_str().map(|s| format!("- {s}"))).collect();
        if v.is_empty() { "- 没有".into() } else { v.join("\n") }
    };
    let weekday = ["日", "一", "二", "三", "四", "五", "六"][date.format("%w").to_string().parse::<usize>().unwrap_or(0)];
    let mut md = format!(
        "# {} 周{weekday}\n\n> 由 Beayy 用当天的记录生成，数据截至 {}。\n\n## 今天的一句话\n\n{}\n\n## 时间都去哪了\n\n- {}\n",
        date.format("%m-%d"),
        Local::now().format("%m-%d %H:%M"),
        j.get("line").and_then(Value::as_str).unwrap_or("").trim(),
        stats.join("\n- ")
    );
    if !domains.is_empty() {
        md += &format!("\n为了什么：\n\n- {}\n\n在做什么：\n\n- {}\n", domains.join("\n- "), acts.join("\n- "));
    }
    md += &format!("\n## 做成了什么\n\n{}\n", list("done"));
    if !rules.is_empty() {
        md += &format!("\n## 规矩\n\n{}\n", rules.iter().map(|(t, d, ok)| format!("- {} {t}：{d}", match ok { Some(true) => "✓", Some(false) => "✗", None => "·" })).collect::<Vec<_>>().join("\n"));
    }
    md += &format!("\n## 偏离\n\n{}\n\n## 明天\n\n{}\n", list("drift"), list("tomorrow"));
    let p = path_of(date);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&p, &md).map_err(|e| e.to_string())?;
    Ok(md)
}

/// 页面上「现在生成」
#[tauri::command]
pub async fn generate_daily(date: String) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    generate(d)
}

/// 定时：每天 21:30 写当天；次日 0:15 以后，前一天那份如果是当天晚上写的，用完整的一天重写一次
pub fn start(paused: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        if paused.load(std::sync::atomic::Ordering::Relaxed) {
            continue;
        }
        let now = Local::now();
        let today = now.date_naive();
        if (now.hour(), now.minute()) >= (21, 30) && !path_of(today).exists() {
            let _ = generate(today);
        }
        if (now.hour(), now.minute()) >= (0, 15) {
            let y = today - Duration::days(1);
            let p = path_of(y);
            let stale = fs::metadata(&p).and_then(|m| m.modified()).map(|t| DateTime::<Local>::from(t).date_naive() == y).unwrap_or(false);
            if stale {
                let _ = generate(y);
            }
        }
    });
}
