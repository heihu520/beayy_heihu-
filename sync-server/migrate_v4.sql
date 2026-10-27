-- v4：官方模型按账号开通（类似会员）。llm_plan：空＝没开通，official＝开通，stopped＝停用；额度按月（token），换月清零
ALTER TABLE users ADD COLUMN llm_plan TEXT;
ALTER TABLE users ADD COLUMN llm_quota INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN llm_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN llm_month TEXT;
