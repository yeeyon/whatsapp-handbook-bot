CREATE TABLE IF NOT EXISTS rag_conversations (
  id BIGSERIAL PRIMARY KEY,
  channel VARCHAR(50) NOT NULL,
  external_id TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (channel, external_id)
);

CREATE TABLE IF NOT EXISTS rag_turns (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES rag_conversations(id) ON DELETE CASCADE,
  user_message TEXT NOT NULL,
  improved_question TEXT,
  assistant_answer TEXT NOT NULL,
  detected_language VARCHAR(20),
  status VARCHAR(30) NOT NULL DEFAULT 'generated',
  retrieval_context JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_feedback (
  id BIGSERIAL PRIMARY KEY,
  turn_id BIGINT NOT NULL REFERENCES rag_turns(id) ON DELETE CASCADE,
  feedback_type VARCHAR(30) NOT NULL,
  content TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rag_memories (
  id BIGSERIAL PRIMARY KEY,
  turn_id BIGINT NOT NULL UNIQUE REFERENCES rag_turns(id) ON DELETE CASCADE,
  memory_type VARCHAR(30) NOT NULL DEFAULT 'delivered_answer',
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding JSONB,
  confidence REAL NOT NULL DEFAULT 0.35,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_turns_conversation_created
  ON rag_turns(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rag_feedback_turn ON rag_feedback(turn_id);
CREATE INDEX IF NOT EXISTS idx_rag_memories_active ON rag_memories(active, updated_at DESC);
