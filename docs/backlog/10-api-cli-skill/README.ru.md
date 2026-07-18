# 10 · API, CLI и Claude Skill (agent-first доступ)

> English version (primary): [README.md](README.md)

Status: backlog · Depends on: 01-07 · Operator's hard requirement + P3 persona

## Что это

Машинный интерфейс, равный человеческому: **REST API** (Supabase PostgREST для данных + n8n
webhooks для действий) + **CLI**, оборачивающий его, + **готовый Claude skill**, который
поставляется с полной документацией — как работать с CLI, структура базы данных, каждый
метод, паттерны запросов — так что агенты фонда подключают токен из своей системы и работают
с сервисом напрямую.

## Зачем (rubric и обоснование)

- Оператор (18 июля): «мне нужно одно — API… чтобы через CLI подключаться со стороны агента
  и работать. Получать данные, обновлять данные, искать». Идея скилла (19 июля): «делаем
  готовый скилл для CLI, чтобы агенты венчуров подключали токен и работали».
- Multi-Attribute NL reasoning — MVP-обязательное (brief §Must-demonstrate 3): «технический
  founder, Берлин, AI infra, enterprise traction, без предыдущего VC backing» решается за
  ОДИН проход (FAQ-12).
- Дифференциатор: из 9 OSS-референсов только sieve-mcp вообще agent-facing (vision.md #4).

## Откуда идея

- Персона P3 (personas.md): стабильный контракт, evidence в каждом ответе, честные поля
  confidence. investor-agent (MIT) — чистый референс паттерна MCP/сервера. Наш собственный
  скилл process-meetings = та форма «skill поверх CLI», которую любит оператор.

## Взгляд на реализацию

1. **REST**: эндпоинты PostgREST поверх таблиц Supabase (founders, cards, claims, scores,
   memos) — read/search бесплатно; эндпоинты n8n webhook для действий: POST /apply (подать
   кандидата), POST /score/{card}, POST /interview/{token}/message, GET /nl-search.
2. **NL-search**: n8n workflow — запрос → LLM → структурированный фильтр
   (sector/geo/traits/tech) + Postgres FTS по claims → ранжированные результаты со сниппетами
   evidence. Без vector DB (оператор).
3. **CLI** (`vcbrain`): тонкий Python Typer или Node commander поверх REST; команды:
   `submit`, `list --ranked`, `card <id>`, `score <id>`, `memo <id>`, `search "<nl query>"`,
   `watch`; `--json` везде; токен через env `VCBRAIN_TOKEN`.
4. **Claude skill** (`skills/vcbrain-cli/SKILL.md` в репо): frontmatter + полный референс —
   структура БД, каталог методов, паттерны запросов, семантика поля evidence, примеры flow
   («найти и сделать memo на founder'а», «мониторить watchlist»). Этот файл И ЕСТЬ артефакт
   submission: судьи видят задокументированный agent-first доступ.
5. OpenAPI: PostgREST отдаёт схему; эндпоинты n8n задокументированы вручную в скилле + в
   коротком api.md.

## Границы и заглушки

MCP-сервер — post-MVP (skill дешевле закрывает историю про агентов). Auth = один service-
токен (без ключей per-fund). Rate limiting — нет (demo).

## Агенты и режимы работы (оркестрация — читать перед грумом)

- **Сначала план:** @implementation-plan-architect ⇄ @implementation-plan-reviewer (до ✅ APPROVED) — здесь план СНАЧАЛА определяет контракт API-поверхности (endpoints, токены, формат ошибок), потом сборка. Git/деплой — ТОЛЬКО @devops.
- **AI-логика (ОБЯЗАТЕЛЬНО `ai-agent-builder`):** агент NL-поиска (запрос → структурный фильтр + FTS).
- **n8n (ОБЯЗАТЕЛЬНО, два n8n-агента):** action-вебхуки (`/apply`, `/score`, `/nl-search`).
- **Дата-модель:** @database-engineer — экспозиция PostgREST (вьюхи, сервисные токены, что публично vs внутреннее); согласовать с 01.
- **Сборка:** @backend-developer — CLI (`vcbrain`, --json везде) + тонкие кастомные endpoints; Claude-скилл пишется по конвенциям глобального `skill-creator`.
- **UX/Дизайн:** нет (только api.md + доки скилла).
- **QA:** @qa-engineer — контрактные тесты на endpoint, evidence-поля в каждом ответе, CLI-smoke всех команд.

## Открытые вопросы

- Язык CLI: Python (Typer, соответствует ops) vs Node (единый runtime с фронтом) — грумить
  на билде; склоняюсь к Python.
- Покрывает ли NL-search также QA «спросить про одного founder'а»? (дешёвое добавление, если
  промпты готовы).
