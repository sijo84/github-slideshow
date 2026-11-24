create table hand_seeds (hand_id uuid primary key references hands on delete cascade, server_seed text not null, salt_key text not null);
