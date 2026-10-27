-- v5：官方服务（模型、转写、地图）按账号开通，每项每月一个上限、用量分开记。llm_plan 当总开关用（official／stopped／空）
ALTER TABLE users ADD COLUMN asr_quota INTEGER NOT NULL DEFAULT 0;   -- 每月转写秒数上限（0＝不限）
ALTER TABLE users ADD COLUMN map_quota INTEGER NOT NULL DEFAULT 0;   -- 每月地图调用次数上限（0＝不限）
CREATE TABLE IF NOT EXISTS usage (
  user TEXT NOT NULL,
  month TEXT NOT NULL,          -- YYYY-MM（UTC）
  service TEXT NOT NULL,        -- llm（token）／asr（音频秒）／map（次）
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, month, service)
);
INSERT OR IGNORE INTO usage (user, month, service, used) SELECT user, llm_month, 'llm', llm_used FROM users WHERE llm_month IS NOT NULL AND llm_used > 0;
