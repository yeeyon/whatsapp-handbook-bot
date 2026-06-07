# WhatsApp Handbook Bot

A separate repo that reuses the **PDF ingestion + RAG** pattern from `whatsapp-claims-poc`:

1. `ingestDocument()` reads a PDF with `pdf-parse`
2. Text is chunked and embedded with Amazon Bedrock Titan
3. Chunks are stored in PostgreSQL (`knowledge_sources`, `knowledge_chunks`)
4. WhatsApp questions are answered with `answerKnowledgeQuestion()`
5. Delivered answers and conversation history are persisted for follow-up questions
6. Positive feedback and corrections become reusable RAG memories; negative feedback disables a learned answer

Your property handbook PDF (`20260606152537803.pdf`) is a scanned/image PDF. Haiku analyzes every page independently so page numbers, measurements, tables, floor-plan labels, and grille drawings remain searchable.

During ingest/backfill, each PDF page is also saved as a JPEG. When a question needs a visual answer (table, diagram, org chart, form, schedule, etc.), WhatsApp replies with the relevant handbook page image after the text answer.

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

To replace old knowledge and stale learned answers after OCR or retrieval changes:

```powershell
npm run reingest
```

The new 66-page source is fully processed first. Old knowledge and conversation learning are removed only after the replacement succeeds.

Verify OCR coverage, page images, grille dimensions, and direct page retrieval with:

```powershell
npm run verify:handbook
```

Scanned PDFs take longer because each page is OCR'd through Bedrock once during ingestion.

If you already ingested text before page images were added, run:

```powershell
npm run backfill-images
```

For older ingestions whose chunks do not have page metadata, repair the mapping once:

```powershell
npm run repair:chunk-pages
```

Images are opt-in: the bot sends at most one page only when the user explicitly asks to show, send, or view a visual item such as a page, form, table, chart, or diagram and retrieval has a relevant page match.

## Test without WhatsApp

```powershell
npm run ask -- "What is the leave policy?"
```

## Run the WhatsApp bot

```powershell
npm start
```

Open `http://localhost:3001`, scan the QR code, then ask handbook questions on WhatsApp.

The bot remembers recent turns for follow-up questions. Feedback can be sent as a separate WhatsApp message:

- `helpful`, `correct`, or `thanks` confirms the previous answer
- `wrong`, `incorrect`, or `not helpful` disables the previous learned answer
- `correction: <the correct information>` stores a user correction for future retrieval

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
- `POST /api/knowledge/ask` with `{ "question": "...", "conversationKey": "employee-123" }`
- `POST /api/knowledge/feedback` with `{ "conversationKey": "employee-123", "type": "positive|negative|correction", "content": "required for correction" }`
