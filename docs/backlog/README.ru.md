# The VC Brain — Бэклог MVP

> English version (primary): [README.md](README.md)

> Одна папка на фичу, пронумерованы 01-12. README.md каждой папки — полный контекст фичи:
> что это, зачем, откуда взялась идея (с источниками) и как видится реализация.
> Груминг / spec / plan / build по каждой фиче идёт в отдельных терминалах; артефакты этой
> работы (spec.md, plan.md) ложатся внутрь папки фичи. Русские версии: README.ru.md рядом с
> каждым файлом. English version: README.md. Идеи не для MVP → [`post-mvp/`](post-mvp/).
>
> Читать в первую очередь: [`../roadmap.md`](../roadmap.md) (зафиксированные решения) ·
> [`../personas.md`](../personas.md) · трекеры intel в `internal/Meetings/`.

**Параллелизация и зависимости: [TRACKER.md](TRACKER.md)** (EN) — волны, критический путь, правила терминалов. Обновляйте там Status по ходу.

## Фичи (MVP)

| # | Фича | Одной строкой | Зависит от |
|---|---|---|---|
| [01](01-memory-data-model/) | Память и модель данных | Supabase-схема: founders, companies, cards, claims+evidence ledger, append-only версионированные scores, watchlist | — |
| [02](02-sourcing-radar/) | Sourcing radar | GitHub+HN-скан → identity resolution → discovery feed; остальные каналы — честные заглушки | 01 |
| [03](03-founder-score/) | Founder Score (cold-start) | Signal/anti-signal скоринг оси Founder; «модель предлагает, backend решает» | 01 |
| [04](04-market-trend-competition/) | Рынок, тренд и конкурентная аналитика | Категория продукта → динамика тренда категории → TAM sanity → конкурентный анализ (Tavily research) | 01 |
| [05](05-truth-gap-trust/) | Truth-gap и Trust Score | Верификация каждого claim, противоречия, trust score; отсутствие данных → confidence вниз | 01, 03, 04 |
| [06](06-memo-decision/) | Memo и решение | Memo с обязательными секциями + deep-dive вопросы + рекомендация на $100K | 03, 04, 05 |
| [07](07-thesis-engine/) | Thesis Engine | Настраиваемая линза фонда: sectors/stage/geo/check/risk; pre-filter gate + линза на feed | 01 |
| [08](08-founder-intake-interview/) | Founder intake и интервью | Минимальная форма → предзаполненное чат-интервью (voice in/out через ElevenLabs) → карточки собираются вживую → share-link для второго интервью | 01, 02 |
| [09](09-investor-dashboard/) | Investor dashboard | Ранжированный feed (K1) + карточка founder + memo view (K2) + заглушки каналов + линза thesis | 01-07 |
| [10](10-api-cli-skill/) | API, CLI и Claude skill | REST (OpenAPI) + Typer CLI + готовый Claude skill с полной документацией | 01-07 |
| [11](11-demo-data-ethics/) | Demo-данные и слой этики | 3-5 реальных founders + 1-2 synthetic-профиля с seeded-противоречиями; opt-out, только публичные данные, data minimisation | 02-08 |
| [12](12-docker-deploy/) | Docker и деплой | docker-compose (api+web), локальный тестовый сервер, VPS в конце | all |

## Легенда статусов

У каждого README фичи есть строка `Status:`: `backlog → groomed → spec → in-build → done`.
Все стартуют как `backlog`.
