# 05 · Проверка Truth-Gap и Trust Score

> English version (primary): [README.md](README.md)

Status: **DONE** (2026-07-19 · QA-гейт пройден за 2 прохода · 197 тестов · 3 живых n8n-workflow · см. [done.md](done.md)) · Depends on: 01, 03, 04

## Что это

Слой diligence: каждый claim на карточке верифицируется против внешнего evidence, получает
**per-claim уровень Trust/confidence**, противоречия помечаются флагом ДО того, как попадут к
инвестору, а пробелы честно логируются. Trust — per-claim, никогда не одно число на компанию
(sponsor FAQ-7).

## Зачем (rubric и обоснование)

- Intelligent Analysis & Trust = 25%; stretch-goal #1 (Agentic Traceability — процитировать
  точный data point за каждым выводом) — выбор Carl как самого рычагового пункта (FAQ-13).
- Инварианты спонсора: отсутствие данных → честно помечать, никогда не выдумывать (REQ-004);
  отсутствие данных → снижать confidence, а не founder score (REQ-003, Carl @1:10:40).
- Кейс BuilderAI (FACT-010): $445M AI-washing прошли ЧЕЛОВЕЧЕСКУЮ diligence, включая
  Microsoft — питч-строка для machine truth-gap.

## Откуда идея

- Паттерн Generator-Validator-Critic (REC-007): валидатор
  проверяет claims против ФАКТОВ (исполнение кода, вызовы API, метрики, результаты поиска),
  никогда — против мнения другой LLM.
- Evidence ledger вместо вайбов (REC-013); сохранение verbatim против LLM echo chamber
  (REC-009, RSK-003); provenance-форензика GitHub (дата первого коммита против более раннего
  источника, /211095).
- sieve-mcp (MIT): типология находок Documented / Discovered / Inferred / Missing — принять
  как наш словарь verification_status. dealgraph README (только идеи): ClaimRouter —
  factual_static→graph, factual_dynamic→web, qualitative→LLM-judge, unverifiable→flag;
  противоречащий claim активно ПОНИЖАЕТ score.
- NotebookLM (19 июля): детекция AI-washing = claims из deck против реального кодабейза —
  реализовать дешёвую версию: claims из deck против реальности GitHub/сайта.

## Взгляд на реализацию

n8n workflow'ы:

1. **`verify-claims`** (на карточку, после 03/04): маршрутизировать каждый неверифицированный
   claim по типу →
   - factual+public (звёзды, даты, деплои, размер команды): прямая проверка через API (GitHub,
     fetch сайта)
   - factual+dynamic (traction, упоминания финансирования): верификация через Tavily search
   - self-reported без прокси: пометить `unverified`, низкий confidence, добавить в gaps
   → status: verified / unverified / contradicted / missing + evidence_quote + source_url.
2. **`contradiction-scan`**: claims из deck/интервью против найденной реальности (например,
   «10k пользователей» против отсутствия видимой traction; список конкурентов founder'а против
   наших находок из 04) → red flags с severity; противоречие детерминированно понижает score
   оси Trust.
3. **`trust-rollup`**: per-axis confidence = f(доля verified, количество противоречий) —
   детерминированная нода; питает шапку карточки и memo.

Каждая верификация пишет строку audit в `events` → это И ЕСТЬ Agentic Traceability для демо:
«кликни на любое число → увидь точный источник и когда мы это проверили».

## Границы и заглушки

Reference-звонки → прокси-сигналы или «References: недоступно на этом этапе» (STUB-003).
Полный adversarial-комитет validator-critic (IDEA-003) — stretch; если хватит времени — один
n8n-агент «адвокат дьявола», который должен найти ≥2 возражения на memo.

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED). Git/деплой — ТОЛЬКО @devops.
- **AI-логика (ОБЯЗАТЕЛЬНО `ai-agent-builder`):** роутер клеймов (factual-static / factual-dynamic / qualitative / unverifiable), детектор противоречий; валидатор проверяет ФАКТЫ, не мнение другой LLM (GVC).
- **n8n (ОБЯЗАТЕЛЬНО, два n8n-агента):** `verify-claims`, `contradiction-scan`, `trust-rollup` (детерминированный).
- **Дата-модель:** @database-engineer — словарь verification_status, audit trail в events; согласовать с 01.
- **UX/Дизайн:** бейджи статусов + паттерн evidence-on-click — словарь/цвета согласовать с @designer (рендер в 09).
- **QA:** @qa-engineer — КРИТИЧНО здесь: нет путей фабрикации, противоречие снижает Trust детерминированно, audit-строка на каждую верификацию.

## Открытые вопросы

- Глубина верификации на бюджет claim'а (вызовы LLM+Tavily) — ограничить на карточку, грумить.
- Уведомлять ли founder'а о противоречащих claims (fairness) или только инвестора в MVP? (Я
  склоняюсь: только инвестор в MVP, видимость для founder'а — post-MVP.)
