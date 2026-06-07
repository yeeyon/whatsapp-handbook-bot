-- Add image_data column to handbook_pages to support database-driven image delivery
ALTER TABLE handbook_pages ADD COLUMN IF NOT EXISTS image_data bytea;
