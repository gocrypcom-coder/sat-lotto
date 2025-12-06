-- schema.sql
-- Datenbankstruktur für Sat-Lotto

CREATE TABLE IF NOT EXISTS rounds (
    id SERIAL PRIMARY KEY,
    state VARCHAR(50) NOT NULL,
    amount_sats INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    future_block INTEGER,
    merkle_root TEXT,
    seed TEXT,            -- NEU: Betreiber-Seed für das Reveal
    seed_hash TEXT        -- NEU: Betreiber-Seed Hash
);

CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
    ticket_id TEXT NOT NULL,       -- R-Hash_Sequenz (z.B. hash_1, hash_2, für Multi-Entry)
    payout_address TEXT NOT NULL,  -- Lightning Address des Teilnehmers
    amount BIGINT NOT NULL,        -- Ticketpreis in Sats
    purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (round_id, ticket_id)
);

-- Die seeds Tabelle wurde zugunsten der rounds Tabelle vereinfacht
-- CREATE TABLE IF NOT EXISTS seeds (...)

CREATE TABLE IF NOT EXISTS winners (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
    winner TEXT NOT NULL,          -- Lightning Address des Gewinners
    prize BIGINT NOT NULL,
    fee BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    drawn_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    round_id INTEGER REFERENCES rounds(id) ON DELETE CASCADE,
    pubkey TEXT NOT NULL,
    payment_request TEXT NOT NULL,
    r_hash TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL,       
    quantity INTEGER NOT NULL,     
    total_amount INTEGER NOT NULL, 
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    settled_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS failed_events (
    id SERIAL PRIMARY KEY,
    event_json TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS failed_payouts (
    id SERIAL PRIMARY KEY,
    round_id INTEGER,
    recipient TEXT,
    amount BIGINT NOT NULL,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Initiale Runden für jede Klasse
INSERT INTO rounds (state, amount_sats) VALUES 
('pending', 100),
('pending', 1000),
('pending', 10000);
