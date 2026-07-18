# Post-MVP Parking Lot

> English version (primary): [README.md](README.md)

Идеи, явно отложенные за пределы 24-часового MVP. Источник: секция «Post-MVP» из roadmap +
блоки Boundaries из README фич.

- **Voice interview agent (ElevenLabs conversational) — ПЕРВЫЙ stretch, внутри хакатона,
  если останется время после MVP** (оператор, 19.07): выбор режима на интейке — текстовый чат
  ИЛИ голосовой агент с сайта, персонализированный по карточке фаундера, с тулами. Оценка
  оператора: на ElevenLabs делается относительно быстро. Дальняя версия дополнительно слышит
  интонацию, паузы, latency — противодействует LLM-ассистированным ответам — и даёт
  ОТДЕЛЬНЫЕ скоры из интервью, вкл. метрики сравнения голос-с-записи vs живой звонок
  (тизерится в UI MVP); для неё нужен
  риск-анализ «text vs voice agent» (устойчивость к gaming, deterrence, доступность, bias,
  consent). UI уже несёт заметку-teaser.
- **Self-learning режим продуктовых агентов** (оператор, 19.07): агенты/ассистенты ведут
  learning MDs — логируют провалы и ошибки, периодически улучшают свои промпты/поведение на
  их основе (та же конвенция, что .claude/agent-learnings/ у dev-агентов, но для ПРОДУКТОВЫХ
  агентов, персистентно в БД/репо).
- Реальная доставка email для follow-up интервью (сейчас замокана).
- MCP-сервер (skill+CLI закрывает агентов в MVP).
- Остальные каналы sourcing: LinkedIn, X, ProductHunt, patents (USPTO/EPO), accelerator
  cohorts, Adzuna hiring-velocity, калибровочная когорта YC OSS API.
- Tech-stack benchmarking конкурентов через публичные репозитории (инсайт NotebookLM).
- Полный визуальный парсинг deck (claims по слайдам).
- Adversarial investment committee (многоагентные дебаты) — stretch, если останется время,
  иначе сюда.
- Обратная связь по противоречиям, видимая founder'у (петля fairness).
- Prediction intervals для founder score (Research Area 1); исследование public-footprint →
  success (Research Area 3).
- Multi-fund tenancy, токены per-fund, back-testing thesis.
- Vector DB для семантического поиска (оператор подключит, если понадобится).
