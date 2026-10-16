//! 本机 MCP 服务：`beayy --mcp`，走标准输入输出（JSON-RPC 2.0，一行一条）。
//! 给 Claude Code、Claude 桌面版这类本机 AI 读你的记录，数据不出这台电脑。只读，不改任何东西。
//! 接入：`claude mcp add beayy -- ~/Applications/Beayy.app/Contents/MacOS/beayy --mcp`

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const VERSION: &str = "2025-06-18";

fn tools() -> Value {
    json!([
        {"name": "list_days", "description": "最近每天的概况：日期、在电脑前秒数、手机秒数、日总结里的一句话。新的在前。",
         "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer", "description": "最多几天，默认 14"}}}},
        {"name": "get_day", "description": "某一天的详情：电脑和手机时长、按小时在做什么（小时摘要）、时间花在哪（领域·项目、类型两级）、手机用得最多的 app、日总结全文。",
         "inputSchema": {"type": "object", "properties": {"date": {"type": "string", "description": "YYYY-MM-DD，本地日期；不填是今天"}}}},
        {"name": "search", "description": "在 10 分钟摘要里搜关键词（标题、描述、经过、涉及的线索），返回命中的时段和内容。适合回答「上周什么时候做过 X」「X 推进到哪了」。",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}, "days": {"type": "integer", "description": "往前搜几天，默认 30"}, "limit": {"type": "integer", "description": "最多返回几条，默认 20"}}, "required": ["query"]}},
        {"name": "get_rules_and_projects", "description": "用户自己定的规矩，以及出现过的项目（所属领域、累计时长）。",
         "inputSchema": {"type": "object", "properties": {}}}
    ])
}

fn text(v: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": v.into()}]})
}

fn local_date(s: Option<&str>) -> String {
    s.filter(|x| !x.is_empty()).map(String::from).unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string())
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "list_days" => {
            let n = args["limit"].as_u64().unwrap_or(14) as usize;
            let days: Vec<Value> = crate::data::list_days().into_iter().take(n)
                .map(|d| json!({"date": d["date"], "computer_sec": d["active_sec"], "phone_sec": d["phone_sec"], "line": d["line"]})).collect();
            Ok(text(serde_json::to_string_pretty(&days).unwrap()))
        }
        "get_day" => {
            let d = crate::data::get_day(local_date(args["date"].as_str()));
            if d.is_null() {
                return Err("日期格式不对，要 YYYY-MM-DD".into());
            }
            let hours: Vec<Value> = d["hours"].as_array().cloned().unwrap_or_default().into_iter()
                .filter(|h| h["title"] != "不在电脑前").map(|h| json!({"start": h["start"], "title": h["title"], "description": h["description"]})).collect();
            let out = json!({
                "date": d["date"],
                "computer": {"active_sec": d["live"]["active_sec"], "first": d["live"]["first"], "last": d["live"]["last"], "switches": d["live"]["switches"], "top_apps": d["live"]["apps"]},
                "phone": {"total_sec": d["phone"]["total_sec"], "pickups": d["phone"]["pickups"], "top_apps": d["phone"]["apps"]},
                "work": d["work"],
                "hours": hours,
                "daily_summary": d["summary_md"],
            });
            Ok(text(serde_json::to_string_pretty(&out).unwrap()))
        }
        "search" => {
            let q = args["query"].as_str().unwrap_or("").trim().to_lowercase();
            if q.is_empty() {
                return Err("要给关键词".into());
            }
            let days = args["days"].as_i64().unwrap_or(30);
            let limit = args["limit"].as_u64().unwrap_or(20) as usize;
            let since = (chrono::Local::now() - chrono::Duration::days(days)).format("%Y-%m-%d").to_string();
            let mut hits = vec![];
            let mut all: Vec<(String, Vec<Value>)> = crate::data::self_segments_pub().into_iter().filter(|(d, _)| *d >= since).collect();
            all.sort_by(|a, b| b.0.cmp(&a.0));
            'outer: for (_, segs) in all {
                for s in segs.iter().rev() {
                    let hay = format!("{} {} {} {} {}", s["title"], s["description"], s["memory"], s["recording"], s["context"]).to_lowercase();
                    if hay.contains(&q) {
                        hits.push(json!({"start": s["start"], "end": s["end"], "title": s["title"], "description": s["description"], "memory": s["memory"], "context": s["context"]}));
                        if hits.len() >= limit {
                            break 'outer;
                        }
                    }
                }
            }
            Ok(text(if hits.is_empty() { format!("最近 {days} 天的摘要里没有「{q}」") } else { serde_json::to_string_pretty(&hits).unwrap() }))
        }
        "get_rules_and_projects" => Ok(text(serde_json::to_string_pretty(&json!({"rules": crate::data::get_rules(), "projects": crate::data::list_projects()})).unwrap())),
        _ => Err(format!("没有这个工具：{name}")),
    }
}

/// 跑 MCP 服务直到标准输入关闭
pub fn serve() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req.get("id").cloned();
        let method = req["method"].as_str().unwrap_or("");
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => Ok(json!({
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or(VERSION),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "beayy", "version": env!("CARGO_PKG_VERSION")},
                "instructions": "Beayy 记录了用户在电脑和手机上的一天：每 10 分钟的摘要、每小时的摘要、时间花在哪些领域和项目、日总结。时间都是 ISO8601（UTC）或本地日期 YYYY-MM-DD。"
            })),
            "tools/list" => Ok(json!({"tools": tools()})),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                match call(name, &req["params"]["arguments"]) {
                    Ok(v) => Ok(v),
                    Err(e) => Ok(json!({"content": [{"type": "text", "text": e}], "isError": true})),
                }
            }
            "ping" => Ok(json!({})),
            _ if id.is_none() => continue, // 通知（如 notifications/initialized）不用回
            _ => Err((-32601, format!("不支持 {method}"))),
        };
        let resp = match result {
            Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
            Err((code, msg)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": msg}}),
        };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}
