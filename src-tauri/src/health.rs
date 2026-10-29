//! 苹果健康：iPhone 每天传一块 `health.<日>`，同步下来存在 `devices/<iPhone>/health/<日>.jsonl`（一行一条，格式见 录音/README.md「苹果健康」）。
//! 这里汇成一天的：昨晚的睡眠、活动（步数、能量、锻炼分钟……苹果去重后的每小时合计）、锻炼、心率、心情，其他所有类型各一行合计。
//! 睡眠按「昨晚」算：前一天 18:00 到这天 18:00 之间的；一天的形状里画的是这一天 0–24 点内的睡眠段（今晚入睡的也画）。

use beayy_core::default_root;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;

struct Row {
    v: Value,
    a: DateTime<Utc>,
    z: DateTime<Utc>,
}

fn utc(v: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

fn iso(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// 有这一天健康数据的设备里行数最多的那台（两台 iPhone 登同一个 Apple 账户时健康数据是同一份，不能相加）
fn device_for(date: NaiveDate) -> Option<String> {
    let name = format!("{}.jsonl", date.format("%Y-%m-%d"));
    let mut best: Option<(usize, String)> = None;
    for e in fs::read_dir(default_root().join("devices")).ok()?.filter_map(|e| e.ok()) {
        let Ok(t) = fs::read_to_string(e.path().join("health").join(&name)) else { continue };
        let n = t.lines().count();
        if best.as_ref().map(|b| n > b.0).unwrap_or(true) {
            best = Some((n, e.file_name().to_string_lossy().to_string()));
        }
    }
    best.map(|b| b.1)
}

fn rows(device: &str, date: NaiveDate) -> Vec<Row> {
    let f = default_root().join("devices").join(device).join("health").join(format!("{}.jsonl", date.format("%Y-%m-%d")));
    fs::read_to_string(f)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| Some(Row { a: utc(&v["start"])?, z: utc(&v["end"])?, v }))
        .collect()
}

fn local_at(date: NaiveDate, h: u32) -> DateTime<Utc> {
    Local.from_local_datetime(&date.and_hms_opt(h, 0, 0).unwrap()).unwrap().with_timezone(&Utc)
}

/// 区间并起来的总秒数
fn union_sec(mut iv: Vec<(DateTime<Utc>, DateTime<Utc>)>) -> i64 {
    iv.sort();
    let mut total = 0;
    let mut cur: Option<(DateTime<Utc>, DateTime<Utc>)> = None;
    for (a, z) in iv {
        match cur {
            Some((ca, cz)) if a <= cz => cur = Some((ca, cz.max(z))),
            Some((ca, cz)) => {
                total += (cz - ca).num_seconds();
                cur = Some((a, z));
            }
            None => cur = Some((a, z)),
        }
    }
    total + cur.map(|(a, z)| (z - a).num_seconds()).unwrap_or(0)
}

/// 睡眠分期（HKCategoryValueSleepAnalysis）：0 在床上、1 睡着（没分期）、2 醒着、3 核心、4 深度、5 快速眼动
const STAGES: [&str; 6] = ["inbed", "asleep", "awake", "core", "deep", "rem"];

/// 一段时间里的睡眠：有手表分期的来源就只用有分期的来源（iPhone 自己估的和手表的会重叠），没有就全用
fn sleep_of(all: &[&Row], from: DateTime<Utc>, to: DateTime<Utc>) -> Option<Value> {
    let rows: Vec<&&Row> = all.iter().filter(|r| r.v["type"] == "SleepAnalysis" && r.z > from && r.a < to).collect();
    if rows.is_empty() {
        return None;
    }
    let staged: std::collections::HashSet<&str> =
        rows.iter().filter(|r| matches!(r.v["value"].as_i64(), Some(3..=5))).filter_map(|r| r.v["bundle"].as_str()).collect();
    let use_row = |r: &Row| r.v["value"] == 0 || staged.is_empty() || r.v["bundle"].as_str().map(|b| staged.contains(b)).unwrap_or(false);
    let pick = |vals: &[i64]| -> Vec<(DateTime<Utc>, DateTime<Utc>)> {
        rows.iter().filter(|r| use_row(r) && vals.contains(&r.v["value"].as_i64().unwrap_or(-1))).map(|r| (r.a.max(from), r.z.min(to))).collect()
    };
    let asleep = pick(&[1, 3, 4, 5]);
    let inbed = pick(&[0, 1, 2, 3, 4, 5]);
    let span = if asleep.is_empty() { &inbed } else { &asleep };
    let start = span.iter().map(|x| x.0).min()?;
    let end = span.iter().map(|x| x.1).max()?;
    let mut blocks: Vec<Value> = rows
        .iter()
        .filter(|r| use_row(r) && r.v["value"] != 0)
        .map(|r| json!({"start": iso(r.a.max(from)), "end": iso(r.z.min(to)), "stage": STAGES.get(r.v["value"].as_u64().unwrap_or(1) as usize).copied().unwrap_or("asleep")}))
        .collect();
    blocks.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    Some(json!({
        "start": iso(start), "end": iso(end),
        "asleep_sec": union_sec(asleep), "inbed_sec": union_sec(inbed),
        "awake_sec": union_sec(pick(&[2])), "core_sec": union_sec(pick(&[3])), "deep_sec": union_sec(pick(&[4])), "rem_sec": union_sec(pick(&[5])),
        "staged": !staged.is_empty(), "blocks": blocks,
    }))
}

/// 常见类型的中文名；没列的显示原名
pub fn type_name(t: &str) -> &str {
    match t {
        "StepCount" => "步数",
        "ActiveEnergyBurned" => "活动能量",
        "BasalEnergyBurned" => "静息能量",
        "AppleExerciseTime" => "锻炼分钟",
        "AppleStandTime" => "站立分钟",
        "AppleMoveTime" => "活动分钟",
        "AppleStandHour" => "站立小时",
        "DistanceWalkingRunning" => "步行跑步距离",
        "DistanceCycling" => "骑行距离",
        "DistanceSwimming" => "游泳距离",
        "FlightsClimbed" => "爬楼层数",
        "HeartRate" => "心率",
        "RestingHeartRate" => "静息心率",
        "WalkingHeartRateAverage" => "步行平均心率",
        "HeartRateVariabilitySDNN" => "心率变异性",
        "HeartRateRecoveryOneMinute" => "心率恢复",
        "OxygenSaturation" => "血氧",
        "RespiratoryRate" => "呼吸频率",
        "VO2Max" => "最大摄氧量",
        "BodyMass" => "体重",
        "BodyMassIndex" => "身体质量指数",
        "BodyFatPercentage" => "体脂率",
        "LeanBodyMass" => "去脂体重",
        "Height" => "身高",
        "WaistCircumference" => "腰围",
        "BodyTemperature" => "体温",
        "AppleSleepingWristTemperature" => "睡眠手腕温度",
        "AppleSleepingBreathingDisturbances" => "睡眠呼吸紊乱",
        "BloodPressureSystolic" => "收缩压",
        "BloodPressureDiastolic" => "舒张压",
        "BloodGlucose" => "血糖",
        "EnvironmentalAudioExposure" => "环境噪音",
        "HeadphoneAudioExposure" => "耳机音量",
        "TimeInDaylight" => "日光下时间",
        "WalkingSpeed" => "步行速度",
        "WalkingStepLength" => "步长",
        "WalkingAsymmetryPercentage" => "步行不对称",
        "WalkingDoubleSupportPercentage" => "双支撑时间",
        "AppleWalkingSteadiness" => "步行稳定性",
        "PhysicalEffort" => "体能消耗",
        "DietaryWater" => "饮水",
        "DietaryCaffeine" => "咖啡因",
        "DietaryEnergyConsumed" => "摄入能量",
        "NumberOfAlcoholicBeverages" => "饮酒杯数",
        "SleepAnalysis" => "睡眠",
        "MindfulSession" => "正念",
        "StateOfMind" => "心情",
        "Workout" => "锻炼",
        "HighHeartRateEvent" => "心率过高提醒",
        "LowHeartRateEvent" => "心率过低提醒",
        "IrregularHeartRhythmEvent" => "心律不齐提醒",
        "EnvironmentalAudioExposureEvent" => "噪音提醒",
        "HeadphoneAudioExposureEvent" => "耳机音量提醒",
        "SleepApneaEvent" => "睡眠呼吸暂停",
        "HandwashingEvent" => "洗手",
        "ToothbrushingEvent" => "刷牙",
        "Headache" => "头痛",
        "Fatigue" => "疲劳",
        "Coughing" => "咳嗽",
        "Electrocardiogram" => "心电图",
        "Audiogram" => "听力图",
        "GAD7" => "焦虑自评",
        "PHQ9" => "抑郁自评",
        _ => t,
    }
}

/// HKWorkoutActivityType → 中文名
pub fn workout_name(n: i64) -> String {
    let s = match n {
        4 => "羽毛球", 6 => "篮球", 8 => "拳击", 9 => "攀岩", 11 => "交叉训练", 13 => "骑行", 14 | 77 | 78 => "跳舞", 16 => "椭圆机",
        20 => "功能性力量训练", 21 => "高尔夫", 24 => "徒步", 28 => "武术", 29 => "身心训练", 35 => "划船", 37 => "跑步", 41 => "足球",
        44 | 68 => "爬楼梯", 46 => "游泳", 47 => "乒乓球", 48 => "网球", 50 => "传统力量训练", 51 => "排球", 52 => "步行", 57 => "瑜伽",
        59 => "核心训练", 60 => "越野滑雪", 61 => "滑雪", 62 => "柔韧训练", 63 => "高强度间歇训练", 64 => "跳绳", 66 => "普拉提",
        67 => "单板滑雪", 72 => "太极", 73 => "混合有氧", 79 => "匹克球", 80 => "放松", 3000 => "其他运动",
        _ => return format!("运动（{n}）"),
    };
    s.to_string()
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// 这一天的健康汇总；没有健康数据返回 None
pub fn health_day(date: NaiveDate) -> Option<Value> {
    let dev = device_for(date).or_else(|| device_for(date - Duration::days(1)))?;
    let prev = rows(&dev, date - Duration::days(1));
    let cur = rows(&dev, date);
    let both: Vec<&Row> = prev.iter().chain(cur.iter()).collect();
    let (s, e) = (local_at(date, 0), local_at(date + Duration::days(1), 0));
    let night = sleep_of(&both, local_at(date - Duration::days(1), 18), local_at(date, 18));
    let strip = sleep_of(&both, s, e).map(|x| x["blocks"].clone()).unwrap_or(json!([]));
    let day: Vec<&Row> = cur.iter().filter(|r| r.a >= s && r.a < e).collect();

    // 每小时合计（苹果去重过的）：按类型加总，步数另给每小时
    let mut sums: BTreeMap<String, (f64, String, usize)> = BTreeMap::new();
    let mut step_hours: BTreeMap<String, f64> = BTreeMap::new();
    // 原始样本：按类型收值
    let mut samples: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
    for r in &day {
        let t = r.v["type"].as_str().unwrap_or("").to_string();
        if r.v["kind"] == "hour" {
            let e = sums.entry(t.clone()).or_insert((0.0, r.v["unit"].as_str().unwrap_or("").to_string(), 0));
            e.0 += r.v["value"].as_f64().unwrap_or(0.0);
            e.2 += 1;
            if t == "StepCount" {
                *step_hours.entry(r.a.with_timezone(&Local).format("%H").to_string()).or_default() += r.v["value"].as_f64().unwrap_or(0.0);
            }
        } else {
            samples.entry(t).or_default().push(r);
        }
    }
    let sum = |t: &str| sums.get(t).map(|x| x.0);
    let vals = |t: &str| -> Vec<f64> { samples.get(t).map(|v| v.iter().filter_map(|r| r.v["value"].as_f64()).collect()).unwrap_or_default() };
    let avg = |v: &[f64]| if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) };
    let last = |t: &str| samples.get(t).and_then(|v| v.iter().max_by_key(|r| r.a)).and_then(|r| r.v["value"].as_f64());

    let hr = vals("HeartRate");
    let stood = samples.get("AppleStandHour").map(|v| v.iter().filter(|r| r.v["value"] == 0).count());
    let activity = json!({
        "steps": sum("StepCount").map(|x| x.round() as i64),
        "active_kcal": sum("ActiveEnergyBurned").map(|x| x.round() as i64),
        "basal_kcal": sum("BasalEnergyBurned").map(|x| x.round() as i64),
        "exercise_min": sum("AppleExerciseTime").map(|x| x.round() as i64),
        "stand_hours": stood,
        "distance_m": sum("DistanceWalkingRunning").map(|x| x.round() as i64),
        "flights": sum("FlightsClimbed").map(|x| x.round() as i64),
        "step_hours": step_hours.into_iter().map(|(k, v)| (k, json!(v.round() as i64))).collect::<serde_json::Map<_, _>>(),
    });
    let heart = json!({
        "avg": avg(&hr).map(|x| x.round() as i64),
        "min": hr.iter().cloned().reduce(f64::min).map(|x| x.round() as i64),
        "max": hr.iter().cloned().reduce(f64::max).map(|x| x.round() as i64),
        "n": hr.len(),
        "resting": last("RestingHeartRate").map(|x| x.round() as i64),
        "hrv_ms": avg(&vals("HeartRateVariabilitySDNN")).map(|x| x.round() as i64),
    });
    let mut workouts: Vec<Value> = samples
        .get("Workout")
        .map(|v| {
            v.iter()
                .map(|r| {
                    let st = &r.v["stats"];
                    let dist = ["DistanceWalkingRunning", "DistanceCycling", "DistanceSwimming", "DistanceWheelchair", "DistanceRowing", "DistancePaddleSports"]
                        .iter()
                        .find_map(|k| st[k]["sum"].as_f64());
                    json!({
                        "name": workout_name(r.v["activity"].as_i64().unwrap_or(3000)),
                        "start": iso(r.a), "end": iso(r.z),
                        "sec": r.v["duration"].as_f64().map(|x| x.round() as i64).unwrap_or((r.z - r.a).num_seconds()),
                        "kcal": st["ActiveEnergyBurned"]["sum"].as_f64().map(|x| x.round() as i64),
                        "distance_m": dist.map(|x| x.round() as i64),
                        "avg_hr": st["HeartRate"]["avg"].as_f64().map(|x| x.round() as i64),
                        "source": r.v["source"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    workouts.sort_by(|a, b| a["start"].as_str().cmp(&b["start"].as_str()));
    let mut moods: Vec<Value> = samples
        .get("StateOfMind")
        .map(|v| v.iter().map(|r| json!({"at": iso(r.a), "valence": r.v["value"], "kind": r.v["mind_kind"], "labels": r.v["labels"], "associations": r.v["associations"]})).collect())
        .unwrap_or_default();
    moods.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    let mindful_sec = samples.get("MindfulSession").map(|v| union_sec(v.iter().map(|r| (r.a, r.z)).collect()));

    // 其他所有类型：合计（每小时的）或平均（样本的）、条数、最后一个值
    const SHOWN: [&str; 7] = ["StepCount", "ActiveEnergyBurned", "AppleExerciseTime", "HeartRate", "Workout", "StateOfMind", "SleepAnalysis"];
    let mut others: Vec<Value> = vec![];
    for (t, (v, unit, n)) in &sums {
        if !SHOWN.contains(&t.as_str()) {
            others.push(json!({"type": t, "name": type_name(t), "agg": "sum", "value": round1(*v), "unit": unit, "n": n}));
        }
    }
    for (t, rs) in &samples {
        if SHOWN.contains(&t.as_str()) {
            continue;
        }
        let v: Vec<f64> = rs.iter().filter_map(|r| r.v["value"].as_f64()).collect();
        let quantity = rs.iter().any(|r| r.v["unit"].is_string());
        let latest = rs.iter().max_by_key(|r| r.a).unwrap();
        others.push(json!({
            "type": t, "name": type_name(t), "n": rs.len(),
            "agg": if quantity { "avg" } else { "count" },
            "value": if quantity { avg(&v).map(round1) } else { None },
            "min": if quantity && v.len() > 1 { v.iter().cloned().reduce(f64::min).map(round1) } else { None },
            "max": if quantity && v.len() > 1 { v.iter().cloned().reduce(f64::max).map(round1) } else { None },
            "unit": latest.v["unit"], "last_at": iso(latest.a),
        }));
    }
    others.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    if night.is_none() && strip.as_array().map(|a| a.is_empty()).unwrap_or(true) && day.is_empty() {
        return None;
    }
    Some(json!({
        "device": dev,
        "sleep": night,
        "sleep_blocks": strip,
        "activity": activity,
        "heart": heart,
        "workouts": workouts,
        "moods": moods,
        "mindful_sec": mindful_sec,
        "others": others,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_overlaps() {
        let t = |m: i64| Utc.timestamp_opt(1_800_000_000 + m * 60, 0).unwrap();
        assert_eq!(union_sec(vec![(t(0), t(10)), (t(5), t(20)), (t(30), t(40))]), 30 * 60);
        assert_eq!(union_sec(vec![]), 0);
    }

    #[test]
    fn sleep_prefers_staged_source() {
        let r = |a: i64, z: i64, v: i64, b: &str| {
            let t = |m: i64| Utc.timestamp_opt(1_800_000_000 + m * 60, 0).unwrap();
            Row { a: t(a), z: t(z), v: json!({"type": "SleepAnalysis", "value": v, "bundle": b}) }
        };
        // iPhone 估的 0–480 分钟「睡着」，手表分期 30–450（中间醒 10 分钟）：只算手表的
        let rows = [r(0, 480, 1, "iphone"), r(-10, 490, 0, "iphone"), r(30, 200, 3, "watch"), r(200, 210, 2, "watch"), r(210, 450, 4, "watch")];
        let refs: Vec<&Row> = rows.iter().collect();
        let t = |m: i64| Utc.timestamp_opt(1_800_000_000 + m * 60, 0).unwrap();
        let s = sleep_of(&refs, t(-600), t(900)).unwrap();
        assert_eq!(s["asleep_sec"], json!(410 * 60));
        assert_eq!(s["awake_sec"], json!(10 * 60));
        assert_eq!(s["deep_sec"], json!(240 * 60));
        assert_eq!(s["inbed_sec"], json!(500 * 60));
        assert_eq!(s["staged"], json!(true));
    }
}
