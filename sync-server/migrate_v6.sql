-- v6：按块名前缀列（places.／transcript.／audio.）走 (user, segment) 范围，不再把账号的块整个扫一遍。
-- 0.2.19 及以前的客户端每 2 分钟 since=0 列三类块，D1 按读到的行计费，10-23 起每天撞免费额度（worker.js 的 list）
CREATE INDEX IF NOT EXISTS blobs_seg ON blobs (user, segment);
