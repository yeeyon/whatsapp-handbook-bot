CREATE TABLE IF NOT EXISTS handbook_pages (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  image_path TEXT NOT NULL,
  ocr_text TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, page_number)
);

CREATE INDEX IF NOT EXISTS idx_handbook_pages_source_id ON handbook_pages(source_id);
CREATE INDEX IF NOT EXISTS idx_handbook_pages_page_number ON handbook_pages(page_number);
