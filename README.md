# WhatsApp Handbook Bot

A separate repo that reuses the **PDF ingestion + RAG** pattern from `whatsapp-claims-poc`:

1. `ingestDocument()` reads a PDF with `pdf-parse`
2. Text is chunked and embedded with Amazon Bedrock Titan
3. Chunks are stored in PostgreSQL (`knowledge_sources`, `knowledge_chunks`)
4. WhatsApp questions are answered with `answerKnowledgeQuestion()`

Your handbook PDF (`20260606152537803.pdf`) is a scanned/image PDF, so when `pdf-parse` returns no text the bot falls back to Bedrock document OCR page by page.

## Setup

```powershell
cd C:\Users\User\CascadeProjects\whatsapp-handbook-bot
copy .env.example .env
npm install
```

Configure `.env` with PostgreSQL and AWS Bedrock credentials (same style as the claims POC).

Create the database:

```sql
CREATE DATABASE whatsapp_handbook;
```

## Ingest the handbook

Point to your PDF path:

```powershell
npm run ingest -- "C:\Users\User\Downloads\20260606152537803.pdf"
```

Or set `HANDBOOK_PATH` in `.env` and run:

```powershell
npm run ingest
```

Scanned PDFs take longer because each page is OCR'd through Bedrock once during ingestion.

## Test without WhatsApp

```powershell
npm run ask -- "What is the leave policy?"
```

## Run the WhatsApp bot

```powershell
npm start
```

Open `http://localhost:3001`, scan the QR code, then ask handbook questions on WhatsApp.

## How it maps to the claims POC

| Claims POC | This repo |
|------------|-----------|
| `src/services/knowledgeBase.js` → `ingestDocument()` | Same flow in `src/services/knowledgeBase.js` |
| `pdf-parse` for PDF text | Same primary extractor |
| `answerKnowledgeQuestion()` | Same RAG answer path |
| WhatsApp `handleFAQ()` | `src/services/whatsapp.js` question handler |
| Admin upload `/api/admin/knowledge/document` | CLI `npm run ingest` |

## API

- `GET /api/health`
- `GET /api/whatsapp/status`
- `GET /api/knowledge/sources`
- `POST /api/knowledge/ask` with `{ "question": "..." }`
