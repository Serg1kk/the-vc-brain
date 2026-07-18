# 04 · Рынок, тренд и конкурентная аналитика

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 01 · Operator-requested (Jul 19)

## Что это

Оси Market и Idea-vs-Market как research-workflow'ы: по карточке компании определить
**категорию продукта**, как **тренд категории двигался и куда движется**, **TAM sanity
check** и **конкурентный анализ** — всё через существующие research-сервисы (Tavily
search/research), без собственных баз данных. Результаты живут как claims (с источниками)
на карточке компании и питают memo.

## Зачем (rubric и обоснование)

- Оператор (19 июля): «не только рынок потенциальный, но и продукт — в какой категории, как
  тренд менялся, меняется ли на перспективу… конкурентный анализ тоже надо делать».
- Brief: ось Market = sizing, конкуренты, SWOT с рейтингом bullish/neutral/bear; memo требует
  Market sizing (явные допущения) и Competition (названные кластеры, дифференциация, будущие
  угрозы).
- Carl: идея должна адресовать огромный рынок; слабый рынок можно компенсировать потенциалом
  команды (SIG-008, Q&A @19:23). Боль zombie-стартапов: поймать потолок рынка ДО чека
  (PAIN-009: формула sanity TAM × 20-30% доли × мультипликатор 5).
- **NotebookLM (project notebook, запрос 19 июля):** инвесторы ожидают TAM/outlook,
  синтезированные из нескольких источников (industry reports, filings, news, social
  sentiment); тренды категории отслеживаются во времени через неструктурированный текст +
  нефинансовые индикаторы (adoption, sentiment); конкурентный анализ = живой sourced
  landscape (реальные конкуренты, истории финансирования), tech-stack benchmarking через
  публичные репозитории, **детекция AI-washing: claims из deck против реального кодабейза**,
  угрозы смежных рынков из неструктурированных упоминаний.

## Откуда идея

- Intel: SIG-013 (moats: distribution/trust/proprietary data — скорость сборки — это table
  stakes), SIG-027 (venture-scale тест: «если это можно уместить в SKILL.md-файл — сюда не
  инвестируют»), SIG-024 (знание founder'ом своих конкурентов = сигнал зрелости — мы СВЕРЯЕМ
  секцию конкурентов из его deck с нашими собственными находками → питает Trust), FACT-009
  (базовые ставки для калибровки).
- OSS: company-research-agent (Apache-2.0, 2k★) — production LangGraph pipeline поверх
  Tavily: collector→curator→enricher→grounding→briefing; перенести логику его стадий в ноды
  n8n. Thesis-Agent README: 13-мерный scoring, тезис тайминга «why now». dealscout README:
  дебатирующие аналитики Market/Product/Traction.
- e/acc KB: thesis-template «два блока: механизм ценности + тайминг why-now» (screening →
  структура memo).

## Взгляд на реализацию

n8n workflow'ы:

1. **`market-intel`**: card → LLM-категоризатор (категория + смежные категории) → fan-out
   Tavily `/search`+`/research`: размер/рост категории, активность финансирования в категории
   (недавние раунды — evidence для «why now»), направление тренда (улучшается/ухудшается/
   стабилен + 2-3 факта с цитатами) → нода TAM sanity (bottom-up: клиенты × выручка; флаг,
   если потолок < venture-scale по формуле PAIN-009) → claims с источниками → под-scores оси
   Market + bullish/neutral/bear.
2. **`competition-intel`**: категория + описание продукта → Tavily search на прямых
   конкурентов (та же ключевая задача) + смежные угрозы → на каждого конкурента: {name, url,
   funding (если публично), дифференциация от цели, threat_level} → сравнение собственных
   claims founder'а о конкурентах с найденной реальностью → расхождение → флаг Trust
   (SIG-024) → блок Competition для card+memo.
3. Обе workflow'ы пишут версионированные scores (тот же append-only паттерн, что и в 03) с
   полем trend.

UI (питает 09): карточка компании получает вкладку «Market»: чип категории, sparkline/стрелка
тренда с цитируемыми фактами, вердикт TAM sanity, таблица конкурентов с threat levels, бейдж
bull/neutral/bear.

## OSS borrow-map (разведчик, 19.07 — см. backlog/_oss-borrow-map.md)

- **Контракт сущности конкурента**: reporting `per_competitor_record` {name, category[direct/
  adjacent/incumbent/alternative], company_mentioned, positioning, stage, most_recent_funding,
  differentiation_vs_target, source_urls} + поля funding/ARR из VCI.
- **Неназванные конкуренты — самый ценный вывод** (reporting: «конкуренты, которых компания
  НЕ упомянула»; build-vs-buy: «реальный конкурент — таблица Excel») — обязательный блок.
- **Выделенный competitive-агент с активным web-discovery**: паттерн Deal_flow_analyzer
  (запросы `'[company] vs [competitor]'`) → форма n8n-workflow.
- **Численные trend-гейты**: VCI `tam_calculator.py` — TAM $1B / CAGR 15% / 5-летняя
  проекция → PASS/WATCH/FAIL; momentum-бонус vantage + генерируемая строка `why_now` +
  поля tailwinds[]/headwinds[] (vcbrain).
- **Возможность дифференциации (gap у ВСЕХ 9 репо):** добавить `threat_level` и
  `switching_cost` как ТИПИЗИРОВАННЫЕ поля записи конкурента (у всех — только проза) —
  дёшево, решить на груме.

## Границы и заглушки

Без платных баз данных (Crunchbase и т.п. — post-MVP). Истории финансирования только из
публичного веба через Tavily. Tech-stack benchmarking конкурентов (идея из NotebookLM) —
пометка post-MVP в UI. Проверка AI-washing deck-vs-codebase живёт в фиче 05 (truth-gap), не
здесь.

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED). Git/деплой — ТОЛЬКО @devops.
- **AI-логика (ОБЯЗАТЕЛЬНО `ai-agent-builder`):** классификатор категории, market/trend-ресерчер, выделенный competitive-агент (web-discovery, неназванные конкуренты).
- **n8n (ОБЯЗАТЕЛЬНО, два n8n-агента):** `market-intel`, `competition-intel`.
- **Дата-модель — ВЕРОЯТЕН ПЕРЕСМОТР СХЕМЫ:** @database-engineer — типизированная сущность конкурента (per_competitor_record + наши поля `threat_level`/`switching_cost`), `why_now`, tailwinds[]/headwinds[] на карточке компании. Согласовать с 01 ДО разработки.
- **UX/Дизайн:** вкладки Market и Competition карточки — макет с @designer здесь, реализация в 09.
- **QA:** @qa-engineer — математика TAM-sanity, дедуп конкурентов, расхождение claims фаундера с найденным → Trust-флаг.

## Открытые вопросы

- Бюджет кредитов Tavily на карточку (search дешёвый, /research mini 4-110 кредитов) —
  ограничить в конфиге; грумить точный fan-out.
- Таксономия категорий: свободная форма LLM или фиксированный список? (Я склоняюсь: свободная
  форма + нода нормализации.)
