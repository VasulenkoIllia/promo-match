# Деплой

Команди на сервері виконує власник, по одній, кожна з позначкою «на Mac» чи «на сервері після ssh». Перед кожною зміною бекап і план відкату. Сервер спільний з іншими проєктами: скрипти `deploy/` торкаються лише свого проєкту compose `promo-match`, своїх тек і старих образів цього репозиторію, без `prune` і `down -v`.

## Сервер (огляд власника 2026-11-07, лише читання)
| Що | Значення |
|---|---|
| Система | Ubuntu 24.04, x86_64, 8 ядер, Docker 29, Compose v5; користувач у групі `docker`; git і cron є; часовий пояс Europe/Kyiv, NTP синхронізований |
| Пам'ять | 15 ГБ, доступно близько 7 ГБ, swap зайнятий частково. Тому ліміти пам'яті обов'язкові: `APP_MEM_LIMIT` 1g, `WORKER_MEM_LIMIT` 2g, `DB_MEM_LIMIT` 2g типово |
| Диск | вільно близько 184 ГБ на тому ж диску, що й тека Docker |
| Traefik | у Docker, мережа `proxy`, entrypoint `websecure`, resolver `cf`, як у сусідніх проєктах: ці значення йдуть у `.env` |
| `forwardedHeaders` | у статичній конфігурації не задано. Traefik не довіряє `X-Forwarded-For` клієнта й ставить туди адресу з'єднання; застосунок довіряє лише приватним адресам (Traefik у мережі Docker), тож `request.ip` це адреса, з якої прийшли до Traefik. Запис DNS іде через проксі Cloudflare (рішення власника 2026-11-07), тож це адреса вузла Cloudflare. Тому ліміти спроб на адресу беруть `CF-Connecting-IP`, лише коли `request.ip` з діапазонів Cloudflare (з 2026-11-07, docs/integrations.md, «Логін») |
| Postgres поруч | є на хості й в інших контейнерах (16 і 18). Наш окремий контейнер `pgvector/pgvector:0.8.7-pg18-trixie`, порт не публікується |
| Вихід | до API і CDN усіх постачальників, Gemini, Anthropic, GitHub і GHCR є (2026-11-07) |
| Мережі Docker | 21 мережа bridge; типові пули Docker дають близько 31, наш compose додає одну (`app-net`). Коли пули скінчаться, нова мережа не створиться (`all predefined address pools have been fully subnetted`, так сталося на Mac під час репетиції), і деплой зупиниться на кроці бази |

## Як код потрапляє на сервер
- Репозиторій публічний на GitHub (docs/decisions.md, 2026-11-07). Кожен push у `main` запускає `.github/workflows/ci.yml`:
  - `verify`: pnpm версії `packageManager` через `npm install --global` (у Node 26 немає corepack), `pnpm install --frozen-lockfile` і `pnpm run check`;
  - `security`: gitleaks по всій історії, `pnpm audit --prod` продакшн-пакетів рівня high, автор кожного коміту з `COMMIT_AUTHOR_EMAIL` і без `Co-authored-by`, shellcheck скриптів `deploy/`, `docker compose config -q`;
  - `image`: збірка, Trivy (CRITICAL зупиняє), пробний старт до `/health`, публікація `ghcr.io/vasulenkoillia/promo-match:sha-<повний коміт>`;
  - `clean-images`: `deploy/clean-images.sh` через `gh api` лишає 30 найновіших версій пакета з тегом і не видаляє образ свого запуску; версій без тегу не чіпає (зараз кожен push це один маніфест з тегом, а дочірні маніфести індексу були б без тегу); збій чистки деплой не зупиняє. Якщо 30 і більше push пройшли без деплою, образ на сервері зникне з GHCR, хоч локальна копія лишиться. Замість `actions/delete-package-versions`, у якої немає версії на Node 24 (рішення власника 2026-11-07);
  - `deploy`: лише коли змінна репозиторію `DEPLOY_ENABLED` дорівнює `true`.
- На pull request workflow не запускається: у публічному репозиторії чужі PR нічого не отримують.
- Сервер нічого не збирає. Він тягне образ і бере з нього лише `docker-compose.yml` і `deploy/deploy.sh`, і то лише ту версію, чий хеш власник дозволив (`approved-infra.sha256`). Образ може змінити застосунок у контейнері, але не хост. Звичайний реліз цих двох файлів не міняє й проходить сам.
- Push лише на слово власника. Стара історія з доменом клієнта лишається локально в гілці `archive/pre-public` (розділ «Публікація репозиторію»).

## Теки на сервері
| Тека | Що там |
|---|---|
| `/var/www/projects/promo-match` | `.env` (0600); `release/` (`docker-compose.yml` і `deploy/deploy.sh` з образу, замінюються кожним деплоєм); `release.prev/` (те саме від останнього релізу, що запрацював, звідси автовідкат бере compose); `current_tag`, `previous_tag`; `backups/` (дампи перед деплоєм і щоденні); `deploy.log`, `failed-start.log`, `nightly.log`, `backup.log`, `restore-check.log`; `.deploy.lock`, `.nightly.lock`, `.restore-check.lock` |
| `/var/www/projects/promo-match-deploy` | `deploy-entry.sh`, `backup.sh`, `nightly.sh`, `approved-infra.sha256`, `crontab-before-promo-match.txt`. Ставляться руками з образу зі звіркою хешу, реліз їх не оновлює |

- Проєкт compose `promo-match` і том `promo-match_db-data`. Назву `name:` у docker-compose.yml і том не міняти: інакше стартує порожня БД. У кожній ручній команді `--project-name promo-match`.
- `docker compose config` без `-q` виводить секрети, на сервері його не запускати.
- Ручні команди нижче йдуть через функцію `pm`. Її треба визначити в кожній новій сесії ssh, вона лише задає параметри compose:

```bash
pm() { (cd /var/www/projects/promo-match && IMAGE_TAG=$(cat current_tag) docker compose --project-name promo-match --env-file .env -f release/docker-compose.yml "$@"); }
```

## GitHub
| Тип | Назва | Значення |
|---|---|---|
| Секрет | `DEPLOY_SSH_KEY` | приватний ключ деплою |
| Секрет | `DEPLOY_HOST` | адреса сервера без проксі Cloudflare: через проксі SSH не пройде |
| Секрет | `DEPLOY_USER` | користувач SSH |
| Секрет | `DEPLOY_KNOWN_HOSTS` | рядок `ssh-keyscan` сервера |
| Змінна | `COMMIT_AUTHOR_EMAIL` | адреси автора через пробіл: пошта git і `users.noreply.github.com`; без неї job `security` падає |
| Змінна | `DEPLOY_ENABLED` | `true` вмикає job `deploy` |

`GITHUB_TOKEN` видається сам і публікує образ у GHCR. Ключ деплою в `authorized_keys` обмежений `command=` і `restrict`: він уміє лише передати тег у `deploy-entry.sh`. Секрети репозиторію бачить будь-яка гілка, тож бар'єр стоїть на сервері.

## Публікація репозиторію (на Mac, один раз)
Стара історія містить домен магазину клієнта (до 2026-11-07 він був у коді й docs), тому на GitHub іде нова історія з одного коміту з тим самим деревом. Нова історія береться з `HEAD`, тож усе, що має піти на GitHub, спершу закомічене; незакомічені правки в робочій теці не зачіпаються й на GitHub не йдуть.

1. Перевірки дерева й нова історія (пише лише локальний git): збіг домену в дереві й файли агентів (`.claude/`, `CLAUDE.local.md`) мають бути порожніми, gitleaks без витоків, у журналі один коміт.
```bash
cd ~/WebstormProjects/promo_match && git grep -il '<CLIENT_DOMAIN>' HEAD; git ls-files | grep -E '^(\.claude/|CLAUDE)'; gitleaks git --no-banner --redact . && git branch archive/pre-public && P=$(git commit-tree 'HEAD^{tree}' -m 'promo-match: перша публічна версія') && git reset --soft "$P" && git log --oneline | head -3
```
2. Репозиторій без push, потім змінні й секрети (розділ «Перше налаштування», кроки 2-3), потім push. Після push у вкладці Actions зелений запуск з jobs `verify`, `security`, `image`; `deploy` пропущений.
```bash
cd ~/WebstormProjects/promo_match && gh repo create VasulenkoIllia/promo-match --public --source . --remote origin
```
Remote `git@github.com:VasulenkoIllia/promo-match.git`, бо `gh` для github.com має протокол `ssh`: push іде SSH-ключем власника, право `workflow` токена не потрібне (перевірено 2026-11-07). Лише для remote HTTPS: GitHub приймає `.github/workflows/` з токеном, що має право `workflow`, а токен `gh` 2026-11-07 його не мав; додати (на Mac, відкриває браузер, вхід робить власник), очікується `workflow` у `Token scopes`:
```bash
cd ~ && gh auth refresh -h github.com -s workflow && gh auth status
```
```bash
cd ~/WebstormProjects/promo_match && git push -u origin main
```
3. Пакет GHCR має бути публічним, щоб сервер тягнув образ без токена. Перевірка (на Mac, лише читає): очікується `200`. Якщо `401`, у налаштуваннях пакета на GitHub змінити видимість на Public.
```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://ghcr.io/token?scope=repository:vasulenkoillia/promo-match:pull"
```

## Перше налаштування
Порядок: картка «Етап: прод» (міняє власник), «Публікація репозиторію», кроки 1-8, «Перенос бази», «Перший деплой», «Розклад». `<TAG>` це `sha-<повний коміт>`, `<COMMIT>` той самий коміт: `git rev-parse main`.

**1. На сервері після ssh: передумови (лише читає).** `deploy.sh` працює окремою сесією, але `KillUserProcesses=yes` вбив би його разом з SSH. Очікується порожній рядок чи `#KillUserProcesses=no`, тека `/var/www/projects`, порти 22 і 443, три шляхи до команд.
```bash
cd /var/www/projects && systemd-analyze cat-config systemd/logind.conf | grep -i KillUserProcesses; ls -ld /var/www/projects; ss -ltn | grep -E ':(22|443) '; command -v flock timeout setsid
```

**2. На Mac: ключ деплою (пише файл).** Очікується пара файлів у `~/.ssh`.
```bash
ssh-keygen -t ed25519 -N '' -C promo-match-deploy -f ~/.ssh/promo_match_deploy
```

**3. На Mac: секрети й змінні (пише в GitHub).** Ключ хоста спершу йде у файл: порожній результат `ssh-keyscan` зупиняє команду, а файл потрібен для перевірок і відкату з Mac. Очікується відбиток `256 SHA256:... (ED25519)` і `✓ Set` на кожну команду.
```bash
cd ~/WebstormProjects/promo_match && ssh-keyscan -t ed25519 '<HOST>' > ~/.ssh/promo_match_known_hosts && ssh-keygen -lf ~/.ssh/promo_match_known_hosts && gh secret set DEPLOY_KNOWN_HOSTS < ~/.ssh/promo_match_known_hosts && gh secret set DEPLOY_SSH_KEY < ~/.ssh/promo_match_deploy && gh secret set DEPLOY_HOST --body '<HOST>' && gh secret set DEPLOY_USER --body '<SSH_USER>' && gh variable set DEPLOY_ENABLED --body false && gh variable set COMMIT_AUTHOR_EMAIL --body '<AUTHOR_EMAIL> <NOREPLY_EMAIL>'
```

**4. На сервері після ssh: теки й ключ хоста (пише).** Очікуються дві теки `drwx------` і той самий відбиток, що на кроці 3; інший відбиток: зупинитись.
```bash
cd /var/www/projects && mkdir -p promo-match/backups promo-match-deploy && chmod 700 promo-match promo-match/backups promo-match-deploy && ls -ld promo-match promo-match-deploy && ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

**5. На сервері після ssh: `.env` (пише).** Спершу значення без секретів і пароль БД, що генерується в команді й ніде не виводиться (лише літери й цифри, бо він стоїть у `DATABASE_URL`). `EMBED_BUDGET_USD` це ліміт одного запуску ембедінгів, тобто й однієї ночі (розділ «Розклад»); `SEARCH_BUDGET_USD` і `QUERY_PARSE_BUDGET_USD` це ліміти доби на ембедінг запиту й розбір його тексту Claude, значення власника 2026-11-07 у docs/decisions.md. Очікується `-rw-------` і назви змінних. Наявний `.env` команда не перезаписує: новий пароль розійшовся б з базою.
```bash
cd /var/www/projects/promo-match && { [ ! -e .env ] || { echo '.env already exists, nothing written'; false; }; } && umask 077 && POSTGRES_PASSWORD=$(openssl rand -hex 24) && printf '%s\n' 'TZ=Europe/Kyiv' 'LOG_LEVEL=info' 'APP_NAME=promo-match' 'APP_DOMAIN=<APP_DOMAIN>' 'TRAEFIK_NETWORK=proxy' 'TRAEFIK_ENTRYPOINT=websecure' 'TRAEFIK_CERTRESOLVER=cf' 'POSTGRES_DB=promo_match' 'POSTGRES_USER=promo_match' "POSTGRES_PASSWORD=$POSTGRES_PASSWORD" 'EMBED_PROVIDER=gemini' 'EMBED_BUDGET_USD=<EMBED_BUDGET_USD>' 'SEARCH_BUDGET_USD=<SEARCH_BUDGET_USD>' 'QUERY_PARSE_BUDGET_USD=<QUERY_PARSE_BUDGET_USD>' > .env && unset POSTGRES_PASSWORD && ls -l .env && cut -d= -f1 .env
```
Потім ключі й адреси фідів, кожне окремо й без показу на екрані: команда питає назву, значення вставляється й не відображається. Порожнє значення пропускається. Очікуються назви всіх змінних.
```bash
cd /var/www/projects/promo-match && umask 077 && for k in AXPOL_LOGIN AXPOL_PASSWORD AXPOL_API_KEY MIDOCEAN_API_KEY MAKITO_CLIENT_ID MAKITO_CLIENT_SECRET INSPIRION_API_KEY BLUECOLLECTION_USERNAME BLUECOLLECTION_PASSWORD GEMINI_API_KEY ANTHROPIC_API_KEY MACMA_FEED_URL EASYGIFTS_FEED_URL ANDA_FEED_TOKEN; do printf '%s: ' "$k"; IFS= read -rs V; echo; [ -z "$V" ] || printf '%s=%s\n' "$k" "$V" >> .env; unset V; done; cut -d= -f1 .env
```

**6. Скрипти з образу (пише).** На Mac (лише читає) хеші скриптів коміту, вони будуть `<HASH_...>`:
```bash
cd ~/WebstormProjects/promo_match && for f in deploy-entry backup nightly; do printf '%s ' "$f"; git show <COMMIT>:deploy/$f.sh | shasum -a 256 | cut -d' ' -f1; done
```
На сервері після ssh. Файли беруться через `docker create` і `docker cp`, без запуску коду образу, лягають поруч під іншим іменем і займають місце лише після збігу хешу. Очікується три `OK` і три файли `-rwxr-x---`; без `OK` нічого не встановлюється.
```bash
cd /var/www/projects/promo-match-deploy && docker pull ghcr.io/vasulenkoillia/promo-match:<TAG> && C=$(docker create ghcr.io/vasulenkoillia/promo-match:<TAG>) && for f in deploy-entry backup nightly; do docker cp -q "$C:/app/deploy/$f.sh" "$f.sh.new"; done; docker rm "$C" >/dev/null; chmod 600 ./*.sh.new && printf '%s\n' '<HASH_DEPLOY_ENTRY>  deploy-entry.sh.new' '<HASH_BACKUP>  backup.sh.new' '<HASH_NIGHTLY>  nightly.sh.new' | sha256sum -c - && for f in deploy-entry backup nightly; do chmod 750 "$f.sh.new" && mv -f "$f.sh.new" "$f.sh"; done && ls -l ./*.sh
```

**7. Дозволити `docker-compose.yml` і `deploy.sh` образу (пише).** На Mac (лише читає) хеш пари з коду:
```bash
cd ~/WebstormProjects/promo_match && (git show <COMMIT>:docker-compose.yml; git show <COMMIT>:deploy/deploy.sh) | shasum -a 256
```
На сервері після ssh. Очікується рядок того самого хешу.
```bash
cd /var/www/projects/promo-match-deploy && docker run --rm --entrypoint cat ghcr.io/vasulenkoillia/promo-match:<TAG> /app/docker-compose.yml /app/deploy/deploy.sh | sha256sum | cut -d' ' -f1 >> approved-infra.sha256 && chmod 600 approved-infra.sha256 && cat approved-infra.sha256
```

**8. На сервері після ssh: обмежений ключ (пише).** `<PUBLIC_KEY>` це вміст `~/.ssh/promo_match_deploy.pub` з Mac. Команда лишає копію `authorized_keys.bak-promo-match` і додає перенос рядка, якщо його немає. Очікується `1`.
```bash
cd ~/.ssh && cp -p authorized_keys authorized_keys.bak-promo-match && { [ -z "$(tail -c1 authorized_keys)" ] || echo >> authorized_keys; } && echo 'command="/var/www/projects/promo-match-deploy/deploy-entry.sh",restrict <PUBLIC_KEY>' >> authorized_keys && grep -c promo-match-deploy authorized_keys
```
На Mac: перевірка обмежень, сервер має відмовити. `-F /dev/null` обов'язковий: без нього `ssh` може взяти основний ключ з агента. Очікується `deploy-entry: expected: <sha-tag> [--skip-migrate]`, `PTY allocation request failed`, `remote port forwarding failed` і ніде немає `uid=`.
```bash
cd ~ && S=(ssh -F /dev/null -i ~/.ssh/promo_match_deploy -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/promo_match_known_hosts); "${S[@]}" '<SSH_USER>@<HOST>' 'id; hostname' 2>&1; "${S[@]}" '<SSH_USER>@<HOST>' 'sha-1234567; id' 2>&1; "${S[@]}" -tt '<SSH_USER>@<HOST>' </dev/null 2>&1; "${S[@]}" -o ExitOnForwardFailure=yes -R 15999:127.0.0.1:22 '<SSH_USER>@<HOST>' 'id' 2>&1
```

## Перенос бази (крок 5, один раз)
Вектори Gemini переносимо базою, не перераховуємо (рішення власника 2026-11-07). У копію не йдуть користувачі, сесії, запрошення й оцінки (`TRUNCATE`, не `DROP`: таблиці лишаються), а також вектори, якими сервер не шукає: `voyage-multimodal-3.5/1024` і `gemini-embedding-2-brand-free/1536`. Прочитані запити (`query_reading`) і свої товари лишаються. Набір міграцій у копії той самий, що в коміті, з якого зібрано образ (19 міграцій, остання `20261107112038_user_roles_invites`).

**1. На Mac: план (лише читає).** Друкує лічильники робочої бази за `deploy/counts.sql` і що лишиться поза копією.
```bash
cd ~/WebstormProjects/promo_match && deploy/export-db.sh
```

**2. На Mac: копія й дамп (пише локально).** Створює локальну базу `promo_match_export`, чистить її, робить `VACUUM`, лічильники й `pg_dump -Fc` у `output/export/` з правами 600 (у дампі закупівельні ціни). Робоча база лише читається. Наприкінці розмір, sha256 і різниця лічильників: мають зникнути лише вектори Voyage й brand-free, а рядки користувачів, сесій і запрошень стати 0. Якщо `promo_match_export` уже є, скрипт зупиняється; стару копію прибрати свідомо: `docker compose -f docker-compose.dev.yml exec db sh -c 'dropdb -U "$POSTGRES_USER" promo_match_export'`.
```bash
cd ~/WebstormProjects/promo_match && deploy/export-db.sh --write
```

**3. На Mac: дамп на сервер (пише на сервер).** Напряму, `-p` зберігає права 600. Потім на сервері після ssh sha256 має збігтися з тим, що надрукував крок 2.
```bash
cd ~/WebstormProjects/promo_match && scp -p output/export/<DUMP> '<SSH_USER>@<HOST>:/var/www/projects/promo-match/backups/'
```
```bash
cd /var/www/projects/promo-match/backups && ls -l <DUMP> && sha256sum <DUMP>
```

**4. На сервері після ssh: лише база (пише).** Compose береться з образу, як це робить `deploy-entry.sh`, і запускається лише після збігу хешу з кодом: `<HASH_COMPOSE>` на Mac дає `git show <COMMIT>:docker-compose.yml | shasum -a 256`. Стартує тільки `db` на порожньому томі. Очікується `OK`, `promo-match_db-data` і `healthy`; без `OK` нічого не стартує.
```bash
cd /var/www/projects/promo-match && mkdir -p release && C=$(docker create ghcr.io/vasulenkoillia/promo-match:<TAG>) && docker cp -q "$C:/app/docker-compose.yml" release/docker-compose.yml; docker rm "$C" >/dev/null; echo '<HASH_COMPOSE>  release/docker-compose.yml' | sha256sum -c - && IMAGE_TAG=<TAG> docker compose --project-name promo-match --env-file .env -f release/docker-compose.yml up -d --no-deps --wait db && docker volume ls --format '{{.Name}}' | grep promo-match && docker ps --filter name=promo-match-db --format '{{.Names}} {{.Status}}'
```

**5. На сервері після ssh: відновлення (пише).** В одній транзакції: помилка лишає базу порожньою. Без власників, бо на сервері свій користувач БД. Індекси HNSW будуються заново, це кілька хвилин. Очікується вихід без рядків `error`.
```bash
cd /var/www/projects/promo-match && IMAGE_TAG=<TAG> docker compose --project-name promo-match --env-file .env -f release/docker-compose.yml exec -T -e PGOPTIONS='-c maintenance_work_mem=512MB -c max_parallel_maintenance_workers=0' db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --exit-on-error --single-transaction' < backups/<DUMP>
```

**6. На сервері після ssh: звірка (лише читає).** Той самий запит, що на Mac, з образу. Вивід надіслати Claude: він має збігтися з `output/export/counts-export-<час>.tsv` рядок у рядок.
```bash
cd /var/www/projects/promo-match && docker run --rm --entrypoint cat ghcr.io/vasulenkoillia/promo-match:<TAG> /app/deploy/counts.sql | IMAGE_TAG=<TAG> docker compose --project-name promo-match --env-file .env -f release/docker-compose.yml exec -T -e PGOPTIONS='-c default_transaction_read_only=on' db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -X -q -At'
```

**Відкат переносу.** До першого деплою на сервері немає нічого нашого, крім цієї бази. Якщо відновлення впало чи лічильники не збіглися: `IMAGE_TAG=<TAG> docker compose --project-name promo-match --env-file .env -f release/docker-compose.yml stop db`, далі разом із Claude і лише з окремого «так» власника видалити том `promo-match_db-data` і повторити з кроку 4. Після першого деплою відкат бази лише з дампу (розділ «Відкат»).

**7. На сервері після ssh: прибрати дамп переносу (рішення власника 2026-11-07).** Коли перший деплой пройшов і є щоденні дампи `scheduled-*`, файл переносу (близько 895 МБ) не потрібен: ротація його не чіпає. Спершу лише читає: очікується один файл `<DUMP>` і щонайменше один `scheduled-*.dump`.
```bash
cd /var/www/projects/promo-match/backups && ls -l promo_match_export-* scheduled-*.dump
```
Потім (пише): видаляє лише цей файл. Очікується, що `ls` його більше не знаходить.
```bash
cd /var/www/projects/promo-match/backups && rm -- <DUMP> && ls -l promo_match_export-* 2>&1 | head -n 1
```

## Перший деплой
**1. На Mac: деплой руками (пише на сервер).** Вивід лише з кроків: `new: <TAG>, running: none`, `== Database`, `dump:` щойно відновленої бази, `== Migrations`, `== Categories`, `== Starting <TAG>`, `== Traefik` і в кінці `== Done: runs <TAG>`. Подробиці (`No pending migrations to apply`, план категорій без змін) у `deploy.log` на сервері. `ServerAliveInterval` обов'язковий: дамп перед деплоєм кілька хвилин нічого не друкує, і 2026-11-07 NAT роутера розірвав тихе з'єднання без keepalive, клієнт висів на `== Database`, а деплой на сервері дійшов до кінця. Тоді стан видно в `deploy.log`.
```bash
ssh -F /dev/null -i ~/.ssh/promo_match_deploy -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o UserKnownHostsFile=~/.ssh/promo_match_known_hosts '<SSH_USER>@<HOST>' '<TAG>'
```

**2. На сервері після ssh: перший адмін (пише).** Самостійної реєстрації немає, а в копії бази користувачів немає. Пароль від 12 знаків питається двічі й не показується. Перед записом команда друкує назву БД.
```bash
cd /var/www/projects/promo-match && pm run --rm --no-deps -e WORKER=users worker node dist/main.js add <LOGIN> --role admin
```

**3. На Mac: перевірка (лише читає).** Очікується `200`. Далі вхід у браузері, пошук текстом, фото й артикулом, екран «Постачальники».
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<APP_DOMAIN>/ready
```

**4. На Mac: автодеплой (пише в GitHub).** Далі кожен зелений push у `main` іде на сервер.
```bash
cd ~/WebstormProjects/promo_match && gh variable set DEPLOY_ENABLED --body true
```

## Як проходить деплой
1. `deploy-entry.sh`: перевірка тегу, `flock` на `.deploy.lock` (чекає до 15 хвилин деплою скасованого запуску). Нічний імпорт тримає те саме блокування до 3 годин від 01:17: деплой, що на нього натрапив, через 15 хвилин червоний, нічого не міняє, і його перезапускають у GitHub пізніше (Re-run job `deploy`). Образ береться локально, якщо вже є, інакше `docker pull` (3 спроби по 6 хвилин). З образу копіюються лише `docker-compose.yml` і `deploy.sh`, далі звірка хешу з `approved-infra.sha256`.
2. `deploy.sh` іде окремою сесією й пише в `deploy.log`, SSH лише показує файл. Обрив зв'язку чи скасування запуску в GitHub деплой не перериває. У журнал GitHub, публічний разом з репозиторієм, ідуть лише кроки (`== ...`), дамп і рядки `deploy: ...` з причиною збою; вивід міграцій, compose і застосунку лишається в `deploy.log` на сервері.
3. Перевірка `.env` і мережі Traefik, поточний тег з живого здорового контейнера, інакше з `current_tag`.
4. Дамп `pg_dump -Fc` у `backups/predeploy-*` з перевіркою `pg_restore --list`, поки база ще на старому конфігу; файл отримує назву лише після перевірки, лишаються 3 останні. Місця має бути 2 ГБ плюс два розміри дампа. Якщо база не відповіла, деплой зупиняється: міграції без дампу не йдуть.
5. Міграції сервісом `migrate` з нового образу, ліміт 30 хвилин. Потім спільні категорії (`WORKER=categories`) з файлів нового образу: план, що прибирає понад 20%, зупиняє деплой до заміни застосунку. Запущена версія тим часом працює.
6. `up -d --no-deps --wait app`: compose чекає healthcheck контейнера, а той питає `/ready` (база відповідає).
7. Успіх: теги в `current_tag` і `previous_tag`, видалення старих локальних образів (лишаються 5 і обидва теги), рядок для відкату.
8. Перевірка маршруту: `https://<APP_DOMAIN>/health` через локальний Traefik до 20 секунд. Інакше деплой червоний, а застосунок лишається запущеним: помилка в мітках чи запису DNS.
9. Неуспіх на кроці 6: автовідкат на попередній тег з compose останнього релізу, що запрацював (`release.prev/`, маркер `.live`), лог застосунку в `failed-start.log`, CI червоний.

Скасований запуск дозавершиться на сервері сам. Результат на сервері після ssh (лише читає):
```bash
cd /var/www/projects/promo-match && tail -n 30 deploy.log && cat current_tag
```

## Зміна `docker-compose.yml` або `deploy.sh`
Деплой такого релізу зупиняється з рядком `... is not approved`. Прочитати зміну на Mac (`git diff <СТАРИЙ_КОМІТ>..<COMMIT> -- docker-compose.yml deploy/deploy.sh`), звірити хеш (крок 7 «Першого налаштування»), дописати його в `approved-infra.sha256` і перезапустити job `deploy` у GitHub. Нові `backup.sh`, `nightly.sh` чи `deploy-entry.sh` реліз не ставить: повторити крок 6 для зміненого файлу.

## Розклад (крок 6)
| Що | Коли (час сервера, Europe/Kyiv) | Що робить |
|---|---|---|
| `nightly.sh` | щодня 01:17 | імпорт постачальників, яких читаємо щодня (з 2026-11-09 разом з Anda Present; без Macma й Easy Gifts, ті лише руками з `--only`), тримаючи `.deploy.lock`; потім ембедінги нового без блокування |
| `backup.sh dump` | щодня 05:23 | `pg_dump -Fc`, повне читання дампу (`pg_restore -f /dev/null`), ротація: 7 щоденних і 4 тижневі (жорсткі посилання, місце не подвоюють) |
| `backup.sh check` | 15-го о 06:47 | найновіший щоденний дамп у тимчасову базу без мережі, порівняння таблиць і рядків з живою, контейнер видаляється разом з томом |

- Час поза вікном переходу на літній час 03:00-04:59. Дамп чекає `.deploy.lock` до 3 годин, тож не зустрічається з імпортом і деплоєм.
- Подвійний запуск: `.nightly.lock` пропускає ніч, якщо попередня ще йде; оренди в базі (`source.sync_lease_*` імпорту, `worker_lease` ембедінгів) не дають двом запускам одного постачальника, зокрема ручному й нічному. Кожна задача має таймаут (імпорт 3 год, ембедінги 6 год), після нього контейнер зупиняється.
- Витрати: ембедінги платні, кожен запуск зупиняється перед викликом, що вивів би витрати за `EMBED_BUDGET_USD` (за прайсом). Тож ніч коштує не більше цього ліміту, місяць не більше 30 таких. Орієнтир: Makito 2026-11-06 це $2,62 за 26 047 фото й 4606 текстів, тобто близько $0,10 на 1000 нових фото. Звичайна ніч з кількома сотнями нових фото коштує центи; новий постачальник рахується окремо з кошторисом `--dry-run` і OK власника.
- Помилки видно лише в логах (`nightly.log`, `backup.log`, `restore-check.log`) і коді виходу; дивитися їх руками командою кроку 6. Сигнал власнику (моніторинг) відкладено до кінця проєкту, рішення власника 2026-11-07.
- Копії бекапу поза сервером немає: втрата сервера означає втрату дампів. Відкладено до кінця проєкту, рішення власника 2026-11-07: каталоги читаються з постачальників знову, локальна база на Mac є станом на 2026-11-07, втратилися б користувачі, оцінки й свої товари після переносу.

**1. На сервері після ssh: передумови (лише читає).** Очікується `flock`, `timeout`, часовий пояс, вільне місце, непорожній crontab (там рядки інших проєктів).
```bash
cd /var/www/projects/promo-match && command -v flock timeout; date +%Z; df -h . "$(docker info --format '{{.DockerRootDir}}')"; crontab -l | wc -l
```

**2. На сервері після ssh: нічний план у середовищі cron (лише читає постачальників і БД, без платних викликів).** `env -i` прибирає змінні сесії, як cron. Очікується план імпорту по постачальниках і кошторис ембедінгів, наприкінці `nightly: done`.
```bash
cd /var/www/projects/promo-match && env -i HOME="$HOME" PATH=/usr/bin:/bin SHELL=/bin/sh /var/www/projects/promo-match-deploy/nightly.sh --dry-run
```

**3. На сервері після ssh: перший дамп у середовищі cron (пише).** Очікується `scheduled-....dump, <N> bytes, <M> different dumps kept`.
```bash
cd /var/www/projects/promo-match && env -i HOME="$HOME" PATH=/usr/bin:/bin SHELL=/bin/sh /var/www/projects/promo-match-deploy/backup.sh dump
```

**4. На сервері після ssh: перевірка відновлення (пише лише тимчасовий контейнер).** Індекси HNSW будуються заново, це кілька хвилин. Очікується `restores: <N> tables`, після неї немає контейнера `promo-match-restore-check`.
```bash
cd /var/www/projects/promo-match && /var/www/projects/promo-match-deploy/backup.sh check && docker ps -a --filter name=promo-match-restore-check --format '{{.Names}}'
```

**5. На сервері після ssh: розклад (пише crontab).** Лише додає блок між маркерами: crontab спільний з іншими проєктами, тож рядків `PATH=`, `TZ=`, `MAILTO=` у блоці немає. Спершу зберігає поточний crontab, тому, якщо `crontab -l` не спрацював, нічого не перезаписується. Очікується перше число, потім воно ж плюс 5, потім 5.
```bash
cd /var/www/projects/promo-match-deploy && crontab -l > crontab-before-promo-match.txt && { cat crontab-before-promo-match.txt; printf '%s\n' '# promo-match: begin' '17 1 * * * umask 077; /var/www/projects/promo-match-deploy/nightly.sh >>/var/www/projects/promo-match/nightly.log 2>&1' '23 5 * * * umask 077; /var/www/projects/promo-match-deploy/backup.sh dump >>/var/www/projects/promo-match/backup.log 2>&1' '47 6 15 * * umask 077; /var/www/projects/promo-match-deploy/backup.sh check >>/var/www/projects/promo-match/restore-check.log 2>&1' '# promo-match: end'; } | crontab - && wc -l < crontab-before-promo-match.txt && crontab -l | wc -l && crontab -l | grep -c 'promo-match'
```

**6. На сервері після ssh: перша ніч (лише читає).** Наступного ранку. Очікується `nightly: done` і свіжий рядок дампу.
```bash
cd /var/www/projects/promo-match && tail -n 20 nightly.log && tail -n 3 backup.log
```

**Прибрати розклад.** На сервері після ssh (пише crontab), лише наш блок. Очікується число рядків без нього.
```bash
crontab -l | sed '/# promo-match: begin/,/# promo-match: end/d' | crontab - && crontab -l | wc -l
```

## Ручні задачі
Та сама функція `pm` (розділ «Теки на сервері»). Не запускати під час деплою: міграції чекали б транзакцій імпорту, а пошук тим часом стоїть.
- План імпорту без запису: `pm run --rm --no-deps -e WORKER=import worker node dist/main.js --dry-run`. Імпорт: та сама команда без `--dry-run`; один постачальник `--only axpol` тощо. Macma й Easy Gifts лише так: `--only macma`, потім `--only easygifts` (адреси фідів у `.env`, docs/integrations.md, «Macma і Easy Gifts»).
- Anda Present (docs/integrations.md, «Anda Present XML»): реліз з адаптером читає Anda щоночі разом з іншими, тож `ANDA_FEED_TOKEN` має бути в `.env` до цього релізу. Без нього worker імпорту зупиняється з `ConfigError` ще до читання, і нічний імпорт не проходить для жодного постачальника. `ANDA_FEED_DIR` на сервері не ставити: worker його відмовляє. Порядок після релізу, по кроку: доступ `--only anda --probe` (один GET `categories/en`, очікується `the feeds answer this IP`), план `--only anda --dry-run`, імпорт `--only anda`, спільні категорії (`WORKER=categories` з `--dry-run`, потім запис: деплой релізу ще не мав рядка Anda в базі й пропустив її шляхи з `WARNING anda: no such source in the database`), кошторис ембедінгів `--only anda --dry-run`. Нічний ліміт ембедінгів бере близько 5000 нових фото за ніч, тож 24 450 фото Anda (кошторис локально 2026-11-09: gemini близько $2,99) без окремого запуску доїдуть за 5-6 ночей; разовий запуск з `-e EMBED_BUDGET_USD=<сума>` лише з OK власника на суму.
**Додати токен Anda в `.env` сервера (пише), якщо його ще немає.** Значення вставляється без показу. Очікується `added` чи `already set`.
```bash
cd /var/www/projects/promo-match && umask 077 && if grep -q '^ANDA_FEED_TOKEN=' .env; then echo 'already set'; else printf 'ANDA_FEED_TOKEN: '; IFS= read -rs V; echo; [ -n "$V" ] && printf 'ANDA_FEED_TOKEN=%s\n' "$V" >> .env && echo added; unset V; fi
```
- Ембедінги: `pm run --rm --no-deps -e WORKER=embed worker node dist/main.js --dry-run` друкує кошторис без викликів; запуск без `--dry-run` лише з OK власника на суму. Один запуск на сервер: два разом на слабкому каналі ловлять таймаути.
- Спільні категорії: `pm run --rm --no-deps -e WORKER=categories worker node dist/main.js --dry-run`, запис без `--dry-run`; план, що прибирає понад 20%, свідомо: `--allow-mass-removal`. Деплой робить це сам після міграцій.
- Користувачі: `pm run --rm --no-deps -e WORKER=users worker node dist/main.js <add|password|disable|enable|list> ...` (docs/integrations.md, «Логін»). `password` і `disable` закривають усі сесії; `password <LOGIN>` вертає вхід, коли адмін один і забув пароль.
- Стан і логи (лише читає): `pm ps`, `pm logs --tail 100 app`.

## Відкат
- Код: на Mac `ssh -F /dev/null -i ~/.ssh/promo_match_deploy -o IdentitiesOnly=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o UserKnownHostsFile=~/.ssh/promo_match_known_hosts '<SSH_USER>@<HOST>' '<PREVIOUS_TAG> --skip-migrate'`, `<PREVIOUS_TAG>` з `previous_tag` на сервері. `--skip-migrate` пропускає й міграції, і категорії. Міграції назад не відкочуються, тому вони лише additive: нові таблиці й колонки, без видалень у тому ж релізі.
- База: лише з дампу (`backups/predeploy-*` чи `scheduled-*`), разом із Claude: зупинити `app`, відновити дамп, звірити лічильники за `deploy/counts.sql`.

## Коли міграція впала
- Міграція з `lock_timeout` 5 с, що не дочекалась блокування (імпорт тримав таблицю), відкочується; `migrate deploy` далі зупиняється, доки її не позначити: `pm run --rm --no-deps worker ./node_modules/.bin/prisma migrate resolve --rolled-back <назва міграції>`, лише після `migrate status`.
- Побудова індексу `CREATE INDEX CONCURRENTLY`, що впала, лишає індекс INVALID: `pm exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP INDEX CONCURRENTLY \"<назва індексу>\""'`, потім `migrate resolve --rolled-back` і повторний деплой. Назва індексу в файлі міграції. `CREATE INDEX CONCURRENTLY` чекає транзакцій, що почалися раніше, тож довгий запит на момент деплою затримує міграцію.

## Нотатки до міграцій
Усі 19 міграцій до `20261107112038_user_roles_invites` уже є в перенесеній базі; нотатки потрібні для розгортання з нуля й для нових міграцій.
- Файли `prisma/migrations/**/migration.sql` комітяться разом зі зміною схеми: без них сервер стартує з тією БД, що є, і `migrate deploy` нічого не каже.
- Образ БД `pgvector/pgvector:<версія>-pg18-trixie`: тег оновлювати лише в межах pg18 і однаково в обох compose; новий major Postgres тільки через бекап і відновлення.
- Міграції з зовнішніми ключами на `photo`, `product_model` і `source` (`embeddings`, `embedding_checks`, `categories`, `own_products`, `photo_search_rank`) чекають блокування не довше 5 с (`lock_timeout`). `model_specs`, `model_print_facts` і `result_grade` без нього чекають транзакцію імпорту, а пошук тим часом стоїть: деплой тримає `.deploy.lock`, тож з нічним імпортом не зустрічається.
- `*_search_index_*` будують індекси HNSW (`CREATE INDEX CONCURRENTLY`); на мільйонах векторів такий індекс будувати окремо від деплою. Нова модель ембедінгів: спершу реліз з її індексами, потім `embed` з нею, тоді індекс будується на порожньому наборі.
- Застосунок працює під користувачем, що створив БД (власник схеми). Окремий користувач з меншими правами додається, коли проєкт цього потребує; запис у docs/decisions.md.

## Застосунок за Traefik
- Лише HTTPS: cookie сесії має `Secure`, без TLS вхід не тримається (`tls=true` у мітках).
- Запис DNS через проксі Cloudflare: режим SSL у Cloudflare Full (strict), бо Traefik має власний сертифікат від resolver-а `cf`, а маршрут є лише на `websecure`. Адреса клієнта приходить у `CF-Connecting-IP`: ліміти спроб на адресу беруть її лише з'єднання з діапазонів Cloudflare (`src/auth/client-ip.ts`, список з cloudflare.com/ips-v4 і ips-v6 станом на 2026-11-07, той самий, що в gps_crm). Cloudflare міняє список раз на роки; новий діапазон, якого немає в коді, означає лише спільний ліміт для людей за ним: коли вхід дає 429 багатьом людям одразу, звірити список з cloudflare.com/ips-v4 і ips-v6. Лог запитів і далі пише `remoteAddress` вузла Cloudflare, не адресу людини.
- Заголовки безпеки (HSTS, nosniff, заборона iframe, referrer policy, CSP) ставить Traefik мітками в docker-compose.yml. Для Telegram Mini App рядок `frameDeny` і `frame-ancestors` у CSP прибрати.
- CSP з 2026-11-07 (рішення власника, до відкриття менеджерам): скрипти, стилі й запити лише з самого застосунку; фото ще з https (CDN постачальників напряму), `blob:` і `data:` для вставленого фото; без `object`, `base`, чужих форм і iframe. Перевірено локально на продакшн-збірці з тим самим заголовком: вхід, пошук з фото 6 постачальників (CDN і проксі `/api/photos/`), вставлене фото, свої товари, «Постачальники», `/invite`, у консолі порушень немає. Новий постачальник з фото не з https чи скрипт Cloudflare на сторінці (Rocket Loader, Web Analytics, JS detections) CSP заблокує: видно в консолі браузера як `violates the following Content Security Policy directive`. У проді 2026-11-07 (сторінка входу, без входу) заголовки CSP, HSTS, nosniff, `X-Frame-Options` і referrer policy є, сторінка працює; Cloudflare вставляє скрипт Web Analytics `static.cloudflareinsights.com/beacon.min.js`, і CSP його блокує: застосунок працює, аналітика Cloudflare для домену ні.
- Зовнішній моніторинг ставити на `https://<APP_DOMAIN>/ready`: він повертає 503, коли БД не відповідає, а `/health` лише показує, що процес живий.
- Посилання запрошень мають вигляд `https://<домен>/invite#<токен>`: токен після `#` у лог Traefik не потрапляє.
- Фото Makito app бере з токеном (`MAKITO_CLIENT_ID`, `MAKITO_CLIENT_SECRET`), фото Macma й Easy Gifts з архівів ZIP на `data.promotray.de`: потрібен лише вихід в інтернет.
