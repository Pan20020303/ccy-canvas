CREATE TABLE IF NOT EXISTS user_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    username varchar(32),
    avatar_url text NOT NULL DEFAULT '',
    headline varchar(120) NOT NULL DEFAULT '',
    bio varchar(300) NOT NULL DEFAULT '',
    location varchar(100) NOT NULL DEFAULT '',
    socials jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_profiles_socials_object CHECK (jsonb_typeof(socials) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_username_unique
    ON user_profiles (lower(username))
    WHERE username IS NOT NULL AND username <> '';
