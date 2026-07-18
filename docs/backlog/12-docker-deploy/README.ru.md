# 12 · Docker и деплой (local-first, VPS в конце)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: all

## Что это

Runtime: **docker-compose** с n8n + Supabase (self-hosted) + web (статичный SPA) —
разрабатывается и тестируется ЛОКАЛЬНО на тестовом сервере оператора; в самом конце
выкладывается на VPS оператора, судьям выдаётся публичный URL для попробовать. Ключи
(OpenAI, Tavily, ElevenLabs) подключаются через .env.

## Зачем (rubric и обоснование)

- Оператор (19 июля): «делаем все в докере, в docker-compose, локально, тестируем… потом на
  серверок выльем, дам сайтик потестировать».
- Submission требует ссылку на рабочий прототип + GitHub repo + zip; живой URL бьёт
  video-only.

## Откуда идея

- Собственный production-паттерн оператора: self-hosted n8n+Supabase через docker-compose на
  VPS (существующий инфраструктурный опыт — именно поэтому переопределение стека на
  n8n+Supabase выигрывает по time-to-demo для ЭТОГО оператора).

## Взгляд на реализацию

1. `docker-compose.yml`: n8n (+ его Postgres или общий), self-hosted набор Supabase, `web`
   (nginx, отдающий сборку SPA). Volumes: supabase db, n8n data, voice storage.
2. `.env.example` (без реальных ключей — правило гигиены репо); реальный `.env` локально +
   на VPS.
3. n8n workflow'ы экспортированы как JSON в `n8n/workflows/` в репо (версионировано, судьи
   могут инспектировать — «наглядно и понятно» — часть техничной истории).
4. Схема Supabase как `supabase/schema.sql`, применяется при первом запуске.
5. Конец хакатона: compose up на VPS, Caddy/nginx TLS, публичный URL; smoke-test
   demo-сценария end-to-end; zip репо для submission.

## Границы и заглушки

Без CI/CD, без бэкапов, без мониторинга (хакатон). Один флаг окружения: DEMO_MODE (прогретые
данные, более быстрые cron'ы).

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED). Git/деплой — ТОЛЬКО @devops.
- **@devops — ЦЕНТР этой фичи:** compose, volumes, разводка .env, деплой на VPS, TLS, smoke демо-сценария end-to-end.
- **Дата-модель:** @database-engineer — применение `supabase/schema.sql` при первом старте.
- **Сборка:** @backend-developer — обвязка compose + экспорт n8n-workflows (`n8n/workflows/` версионируется в репо).
- **n8n:** дисциплина экспорта/импорта через глобальный скилл `n8n` (управление инстансами); сами workflows приходят из фич 02-11.
- **UX/Дизайн:** нет.
- **QA:** @qa-engineer — cold-boot тест (свежий клон → compose up → демо работает), проверка DEMO_MODE pre-warm.

## Открытые вопросы

- Переиспользовать существующий локальный инстанс n8n оператора для сборки workflow'ов, потом
  экспортировать → compose? (Быстрее, чем стартовать с нуля; грумить с оператором в начале
  билда.)
- Целевой VPS: который из серверов оператора — оператор решает во время деплоя.
