# 06 · Инвестиционный меморандум и решение на $100K

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 03, 04, 05

## Что это

Готовый к решению вывод: memo с **обязательными секциями** спонсора, каждый claim прослежен
до evidence с confidence, пробелы честно проговорены, **предложенные deep-dive вопросы для
звонка с founder'ом** и рекомендация на $100K с условиями. Генерируется n8n workflow'ом,
рендерится в dashboard, экспортируется.

## Зачем (rubric и обоснование)

- Investment Utility & Execution = 30%: «может ли инвестор-человек реально действовать в
  течение 24ч».
- Обязательные секции (brief Appendix 1 + FAQ-8): Company snapshot, Investment hypotheses,
  SWOT, Problem & product, Traction & KPIs. Всё остальное опционально; **padding работает
  против нас** (длина ≠ строгость).
- Никогда не выдумывать: честность «Cap table: не раскрыт» даёт ВЫШЕ trust (REQ-004, FAQ-9).
- Ценность pre-call: у инвестора 30-60 минут; memo должен сказать, ГДЕ копать (REC-005, Carl
  @27:00; PAIN-004).

## Откуда идея

- Carl Q&A: рекомендация ≠ решение, без звонка founder'у в петле (REQ-001); несколько scores
  показаны раздельно + как каждый выведен (REQ-002 @52:31).
- NotebookLM (19 июля): структурированный memo в стиле консалтинга — матрица оценки рисков,
  инвестиционный тезис, анализ рынка, чёткий proceed/pass, полный citation trail, аудируемый
  IC/LP.
- Benchmark-оценка вместо выдуманных цифр (REC-015): «похожий стартап в этой
  категории/периоде поднял X по Y» — честно заполняет Financials, когда реальных цифр нет.
- Thesis-template: два блока — механизм ценности + тайминг «why now» (идёт в Investment
  hypotheses). Промпты vcbrain `vc-memo-writer` как референс.

## Взгляд на реализацию

n8n workflow **`generate-memo`** (промпты через ai-agent-builder):

1. Сбор: card + все scores по осям (последние версии) + claims со статусами + gaps + конфиг
   thesis → context pack.
2. Section writers (по одной LLM-ноде на секцию, вывод JSON, цитаты = ТОЛЬКО claim_ids —
   рендерер резолвит их в источники; section writer НЕ МОЖЕТ ввести факт без цитаты):
   snapshot · hypotheses (включая why-now) · SWOT (каждый буллет подкреплён evidence) ·
   problem & product · traction & KPIs (только verified; unverified явно помечены) · risk
   matrix · competition (из 04) · financials-lite (benchmark-компараблы + пометки «не
   раскрыто»).
3. **`deep-dive-questions`**: из gaps + противоречий + AMBIGUOUS claims → 5-7 вопросов
   «покопать глубже на звонке», у каждого — ПОЧЕМУ (какой gap он закрывает).
4. Нода решения (детерминированная): fit по thesis + scores по осям + trust → рекомендация
   {proceed / proceed-with-conditions / pass / watchlist} + обоснование $100K. Оси НИКОГДА
   не усредняются — расхождение между осями показывается как есть.
5. Рендер: memo view в dashboard (09) + markdown-экспорт; хранится версионированно в Supabase.

## Границы и заглушки

Financials/cap table — только «не раскрыто» + блок benchmark. Exit-перспектива / DD-лог —
опциональные секции, включать только если дёшево. Adversarial committee pass — stretch (см.
05).

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED). Git/деплой — ТОЛЬКО @devops.
- **AI-логика (ОБЯЗАТЕЛЬНО `ai-agent-builder`):** агенты-писатели секций (цитаты = только claim_ids), агент deep-dive-вопросов; decision-нода детерминированная (НЕ LLM-вызов).
- **n8n (ОБЯЗАТЕЛЬНО, два n8n-агента):** `generate-memo`, `deep-dive-questions`.
- **Дата-модель — ВОЗМОЖНО ДОПОЛНЕНИЕ СХЕМЫ:** @database-engineer — версионируемая таблица `memos` (нет в первом срезе 01); согласовать с 01.
- **UX/Дизайн:** memo view — первоклассный артефакт инвестора: layout с @designer (trust-бейджи, блок вопросов, баннер рекомендации); реализация в 09.
- **QA:** @qa-engineer — нецитированный факт не рендерится, required-секции на месте, пути «not disclosed», защита от padding (length ≠ rigor).

## Открытые вопросы

- Целевая длина memo (1 экран? 2?) — грумить с оператором против «padding работает против
  нас».
- Пороги рекомендации (какая комбинация score/trust → proceed) — строка конфига, настраивается
  под демо.
