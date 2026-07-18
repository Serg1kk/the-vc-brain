# 02 · Sourcing Radar (GitHub + HN, один канал вглубь)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 01

## Что это

Outbound-трек: n8n workflow, который непрерывно (cron) сканирует **HN Show HN + GitHub**,
резолвит identity (GitHub-профиль как хаб), строит записи founder/company с claims и питает
discovery feed «founders, о которых стоит знать». Остальные каналы (LinkedIn, X, ProductHunt,
patents…) показаны в dashboard как честные **заглушки** — UI демонстрирует мультиканальное
видение, а по-настоящему глубоко работает один канал.

## Зачем (rubric и обоснование)

- Sourcing — **самая важная часть MVP** по брифу; Carl: глубина ОДНОГО канала важнее широты
  (REC-001, Q&A @1:00:22). Судьи оценивают богатство данных и умные идеи sourcing, а не полировку.
- Слепая зона спонсора именно здесь: ранние команды не представлены на Crunchbase/Dealroom
  (PAIN-002, Carl @1:03:03) — первичные цифровые следы — единственное место, где они видны.
- Тайбрейкер cold-start (примечание rubric): radar находит людей ДО того, как появился
  track record.

## Откуда идея

- `internal/research/data-sources.md` — полное решение по стеку: GitHub GraphQL (бесплатно,
  5k запросов/ч, самые богатые честные сигналы), HN Algolia (бесплатно, без ключа,
  `tags=show_hn` = готовая воронка «построил и показал»), Tavily crawl для личных сайтов.
  Юридические красные линии задокументированы там же.
- **Identity resolution без ML** (тот же документ): HN username → GitHub login → profile.blog
  → личный сайт → ссылки LinkedIn/X в футере. GitHub-профиль — это хаб.
- Thesis-Agent README (без лицензии, только идеи): таблица из 12 источников, hiring-velocity
  как предиктор.
- Intel: FACT-011 (скрытые сигналы живут в комментариях сообщества), SIG-015 (затухание
  hackathon-сигнала).

## Взгляд на реализацию

n8n workflow'ы (собраны через n8n-requirements-orchestrator → n8n-workflow-builder):

1. **`radar-scan`** (cron, ~15 мин в demo-режиме): свежие items из HN Algolia `show_hn` →
   фильтр (thesis pre-gate из фичи 07) → для каждого: GitHub user lookup (GraphQL: profile,
   repos, contributionsCollection, languages) → Tavily extract по личному сайту → запись claims
   в Supabase (raw snapshots + извлечённые claims, помечены источником).
2. **`identity-resolve`** (саб-workflow): каскад выше; confidence на каждую ссылку;
   неоднозначно → флаг, никогда не угадывать.
3. **`radar-score-trigger`**: новая/обновлённая card → вызывает scoring workflow из фичи 03 →
   если score пересекает thesis-порог → появляется в discovery feed + заглушка карточки
   «предложенный outreach» (STUB-001: черновик сообщения показан, ничего не отправляется —
   outreach вне скоупа, SCOPE-002/003).

Rate limits на demo-масштабе не проблема (GitHub 5k/ч, HN 10k/ч). Уважение robots.txt в ноде
краулинга — видимо, это оцениваемый пункт этики.

## Границы и заглушки

Каналы LinkedIn / X / ProductHunt / patents / accelerators: записи в сайдбаре с «coming
soon» + честный тултип (что бы это добавило). Без реального outreach. Без непрерывного
24/7-краулинга — cron со скромными окнами; demo прогрет заранее заготовленным сканом.

## Открытые вопросы

- Какое окно HN для живого демо (последние 48ч Show HN?) — выбрать во время билда;
  заранее отобрать 3-5 реальных founders из него (фича 11).
- Scope GitHub PAT: только публичный classic-токен (создать во время билда).
