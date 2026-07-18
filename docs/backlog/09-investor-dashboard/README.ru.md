# 09 · Investor Dashboard (K1 triage + K2 pre-call)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 01-07

## Что это

SPA для инвестора: **ранжированный feed** (inbound + radar, линза thesis, заглушки каналов) →
**карточка founder/company** (оси с трендами, evidence ledger, gaps, вкладки market/
competition) → **memo view**. Основные контексты K1 (утренний triage) и K2 (подготовка к
звонку) по personas.md.

## Зачем (rubric и обоснование)

- UX = 15%, но привратник trust: «Notion-уровень approachability + Bloomberg-уровень
  аналитической глубины» (brief §8); без усилий для НЕ-технического инвестора.
- REQ-002: несколько scores показаны раздельно + как каждый выведен — карточка И ЕСТЬ это.
- Оператор: мультиисточниковый dashboard с честными заглушками каналов («полноценный
  интерфейс виден»).
- Недоверие к чёрным ящикам — базовая эмоция P1 → evidence-on-click — это предпосылка trust.

## Откуда идея

- Контексты P1 K1-K5 из personas.md; UX-скелет из чат-брейншторма (6 экранов).
- reporting (Apache-2.0): `components/diligence/*`, `research-card.tsx` — отполированный UI
  как референс для перерисовки (не для извлечения). Концепция dashboard vcbrain; бейджи
  типизации evidence из sieve-mcp. Отчёт OSS-scout (в работе) добавит карту заимствований по
  секциям карточки.
- Путь дизайна оператора: Lovable И Claude Design пробуют одну и ту же задачу; фронт — чистый
  потребитель REST/Supabase, так что оба могут соревноваться без изменений backend.

## Взгляд на реализацию

Экраны (SPA поверх Supabase REST + n8n webhooks):

1. **Feed**: сайдбар Inbound/Radar/Watchlist + список каналов (GitHub ✅, HN ✅, LinkedIn 🔒,
   X 🔒, ProductHunt 🔒 — заглушки с честными тултипами); строки: имя/компания/one-liner,
   **4 мини-бара по осям** (Founder/Market/Idea-vs-Market/Trust — никогда одно число),
   стрелки тренда, бейдж источника, свежесть; переключатель линзы thesis пересортировывает
   вживую.
2. **Card**: hero с осями+трендами; вкладки: Evidence (таблица ledger: claim → ссылка на
   источник → confidence → бейдж статуса), Market (чип категории, стрелка тренда + цитируемые
   факты, TAM sanity, bull/neutral/bear), Competition (таблица с threat levels), Interview
   (транскрипт + плееры voice-артефактов), честный блок «Что мы не знаем»; действия: View
   memo · Request follow-up interview · delete-on-request (этика).
3. **Memo view**: обязательные секции, бейджи trust на каждый claim, блок deep-dive вопросов,
   баннер рекомендации с сработавшими правилами thesis; экспорт в markdown.
4. **Thesis config** (форма из 07). 5. Экраны founder-стороны живут в 08.

Открытые UX-вопросы оператору (ожидают из брейншторма): плотность dashboard (просторные
строки с раскрываемой глубиной — мой лин), split-screen live-preview в интервью, первый кадр
демо, светлая/тёмная тема.

## Границы и заглушки

Без экранов auth (один фонд). Заглушки каналов кликабельны → панель «coming soon» с тем, что
добавил бы канал. Mobile — не цель (судьи смотрят десктопное демо).

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED). Git/деплой — ТОЛЬКО @devops.
- **UX/Дизайн — @designer ЦЕНТР этой фичи + UX-брейншторм с оператором** (4 открытых вопроса: плотность, live-preview, первый кадр демо, тема). Готовит дизайн-бриф + токены для бейк-оффа Lovable vs Claude Design; investor-grade «Notion approachability + Bloomberg depth».
- **Сборка:** @frontend-developer — SPA поверх Supabase REST + n8n webhooks; чистый REST, фронт остаётся подменяемым.
- **AI-логика:** новой нет (рендерит выходы 03-07). UI NL-поиска бьёт в endpoint фичи 10.
- **Дата-модель:** @database-engineer — только read-вьюхи; изменений схемы не ожидается.
- **QA:** @qa-engineer — оси нигде в UI не схлопываются в одно число (REQ-002), evidence-on-click работает для каждой отрисованной цифры, каналы-заглушки честные.

## Открытые вопросы

- Bake-off Lovable vs Claude Design — оператор прогоняет оба, мы выбираем; агент @designer
  готовит дизайн-бриф + токены заранее.
