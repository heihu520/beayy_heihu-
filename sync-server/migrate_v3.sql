-- v3：账号的显示名称和头像（头像是压到 128 像素的 data URL）。这两项不加密：和邮箱一样属于账号资料，不是记录内容
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE users ADD COLUMN profile_updated INTEGER NOT NULL DEFAULT 0;
