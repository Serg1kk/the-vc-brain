# 01 · Память и модель данных (Supabase)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: — · Blocks: everything

> **Дизайн утверждён (19.07.2026): [design.md](design.md)** (EN) — заменяет секцию
> «Implementation view» ниже.

## Что это

Постоянный слой Memory в The VC Brain на **Supabase (Postgres)**: founders, companies,
cards, claims с evidence, версионированные scores, watchlist, интервью и voice-артефакты.
«Ничего не выбрасывается» — дедуплицировано, с таймстампами, помечено источником (challenge
brief, столп Memory). PostgREST даёт REST-поверхность над этими таблицами бесплатно (питает
фичу 10).

## Зачем (rubric и обоснование)

- Data Architecture & Intelligence = **30%** оценки; примечание брифа: generic ingestion
  оценивается низко, если не служит cold-start кейсу.
- Требования спонсора: Founder Score **сохраняется между заявками и никогда не сбрасывается**
  (REQ-011/FAQ-6); слой памяти нужен, чтобы потом на нём итерировать/обучать (REQ-009, Carl @57:38).
- Требование по тренду: каждая ось показывает тренд во времени → scores должны быть
  **append-only версиями**, а не перезаписью.

## Откуда идея

- Challenge brief §2, столп Memory; Carl Q&A (internal/Meetings/requirements.md REQ-009).
- **vantage (MIT)**: append-only версионированные scores с `prompt_version`+`formula_version`,
  ledger `ai_outputs` — перенести этот паттерн в таблицы Postgres.
- InGa: концепция постоянной памяти тенанта; reporting: supabase/migrations как референс схемы.
- Intel: REC-010 (watchlist), REC-013 (evidence ledger), SIG-025 (траектория после отказа).

## Взгляд на реализацию

Таблицы Supabase (первый черновик):

- `founders` (id, name, links{github,hn,site,li,x}, created_at) + `companies` (id, name,
  founder_ids, category, stage, source_track: inbound|radar)
- `cards` (id, subject_type: founder|company|team, subject_id, status, completeness)
- `claims` (id, card_id, axis: founder|market|idea_vs_market|trust, text_verbatim, source_kind:
  self_reported|public|interview|voice, source_url, confidence 0-1, verification_status:
  verified|unverified|contradicted|missing, evidence_quote, created_at) — **evidence ledger**
- `scores` (id, subject_id, axis, value, trend, formula_version, prompt_version, inputs_json,
  created_at) — **append-only**; текущий score = последняя строка по (subject, axis). Никогда
  не UPDATE.
- `interviews` (id, card_id, kind: first|follow_up, share_token, transcript_json, status)
- `voice_artifacts` (id, interview_id, question_id, storage_path, duration) → Supabase Storage
- `watchlist` (subject_id, reason, last_scored_at) · `events` (audит-трейл: что запускалось когда)

Со стороны n8n: workflow'ы пишут ТОЛЬКО через Supabase API (service key), никогда — сырой SQL
из множества мест: один саб-workflow «DB-write» на сущность держит записи консистентными
(«модель предлагает, backend решает»: вывод LLM → нода валидации → insert).

## Границы и заглушки

Без vector DB (решение оператора — простого Postgres + FTS достаточно для grounding NL-поиска
в MVP). Без multi-tenancy/auth сверх одного фонда + service-токенов. Без tooling для миграций —
schema.sql применяется один раз, изменения аддитивные.

## Открытые вопросы

- Supabase локально (полный стек в docker-compose) vs существующий self-hosted инстанс
  оператора для dev — решить в фиче 12.
- Хранить ли сырые JSON-снепшоты GitHub/HN (provenance) или только извлечённые claims? (Я
  склоняюсь: хранить сырьё в таблице `raw_snapshots` — дёшево, а provenance — наше
  дифференцирующее преимущество.)
