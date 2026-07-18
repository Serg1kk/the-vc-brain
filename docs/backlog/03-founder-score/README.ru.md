# 03 · Founder Score (ядро cold-start)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 01 · The heart of the product

## Что это

Founder Score, подкреплённый evidence: n8n scoring pipeline, который превращает публичный
цифровой след founder'а + claims из интервью в **постоянный, версионированный, объяснимый
score** по оси Founder — рассчитан на founder'а БЕЗ track record. «Модель предлагает, backend
решает»: ноды LLM выдают под-scores С цитатами evidence; детерминированная нода n8n
агрегирует по версионированным весам; Supabase хранит каждую версию append-only.

## Зачем (rubric и обоснование)

- Carl, дословно: problem/market/SWOT «сегодня довольно легко делать с Claude… по-настоящему
  оценить founder'а, найти хороший scoring — вот это сложная часть челленджа» (FACT-007).
- Тайбрейкер rubric: generic ingestion оценивается низко, если не решает кейс **cold-start,
  без track record**. Эта фича И ЕСТЬ ответ на это.
- Инварианты спонсора: оси никогда не усредняются (REQ-002); Founder Score живёт в Memory,
  никогда не сбрасывается, питает каждое решение (FAQ-6); отсутствие данных → confidence вниз,
  а не score (REQ-003).

## Откуда идея

- Три вопроса Carl (Q&A @33-35min): пошёл бы я работать на них / могут ли они продавать /
  могут ли они масштабироваться (SIG-003/004/005). Триада фонда integrity/energy/resilience
  (SIG-022); rubric из 8 черт (SIG-023); founder-first тезис «важен почти только founder»
  (SIG-021).
- **Калибровка сигналов 2026-го года из нашей e/acc KB (906 items)** — наше нечестное
  преимущество:
  - shipped-vs-built: prod deploy + внешняя traction, а не объём кода (SIG-012, t.me/eaccchat/187646)
  - vibe-coding обесценил сигнал прототипа (RSK-002, t.me/eaccchat/3061, 30 июня)
  - звёзды GitHub = vanity; provenance-проверка даты первого коммита против более раннего
    источника (SIG-014, /3033, /211095)
  - agency/completion ratio: завершённые vs брошенные проекты (SIG-011, cryptoessay/2753)
  - domain expertise 40+ / управленческий навык как предиктор (SIG-016), hands-on-at-scale
    (SIG-017)
  - анти-сигналы: headcount (SIG-019), отполированный питч — persuasion обесценен (SIG-018)
  - GTM-компетенция для B2B (SIG-020); апдейты после отказа как редкий сигнал persistence
    (SIG-025)
- vantage (MIT): паттерн агрегации scoring.py; sieve-mcp: типизация evidence
  Documented/Discovered/Inferred/Missing.
- Защиты: RSK-003 (verbatim-слой против LLM echo chamber), RSK-004 (survivorship-aware:
  никаких фич «похоже на прошлых победителей»; YC directory — опциональная ground-truth
  проверка).

## Взгляд на реализацию

n8n workflow'ы (через ai-agent-builder для каждого промпта):

1. **`score-founder`** (вызывается radar/intake): вход = card_id → собрать claims из Supabase
   → параллельные LLM суб-scorer'ы (каждый — агент, специфицированный через ai-agent-builder,
   с JSON-выводом): `execution-signals` (shipped/agency/provenance), `expertise-signals`
   (domain, hands-on), `leadership-sales-proxies` (публичные прокси SIG-003/004), `red-flags`
   → каждый возвращает {signal, value, evidence:[claim_ids], confidence, missing:[]}.
2. **`aggregate-score`** (Code-нода, детерминированная): версионированные веса (formula_v1 в
   строке конфига), отсутствие данных → только штраф к confidence; пишет строку `scores`
   (append-only) + trend относительно предыдущей версии.
3. Контракт вывода: score + разбивка по сигналам + ссылки на evidence + confidence + честный
   список «чего мы не знаем» — потребляется card UI (09), memo (06), API (10).

OQ-002 (какие 5-7 метрик GitHub) закрывается ЗДЕСЬ во время груминга: кандидатный набор =
merged PR в чужие репозитории · release-completion ratio · provenance первого коммита ·
evidence prod-deploy · consistency-over-time · глубина domain-контента. НЕ: звёзды, LOC,
объём коммитов.

## Границы и заглушки

Анализ social-personality (черты X/Twitter) — stretch по Carl (SCOPE-005), заглушка в виде
затемнённого блока «Personality (research)». Без prediction intervals (Research Area 1) —
вместо этого честно показываем confidence.

## Открытые вопросы

- Финальные веса formula_v1 — грумить с оператором; держать таблицу конфига, чтобы судьи
  видели настраиваемость.
- Прогонять ли калибровочный пасс по YC-directory, если хватит времени (killer-слайд, ~1ч)?
