# CGB PostgreSQL API

Закрытый серверный слой между браузером и PostgreSQL. Предоставляет авторизацию, разрешённые запросы к таблицам/RPC и хранение файлов на VPS. Слушает только localhost; наружу публикуется Nginx по `/api/v1/`.

## Запуск

```bash
npm ci --omit=dev
cp .env.example .env
npm start
```

В рабочей установке используйте `/etc/cgb-postgres-api.env` с правами `600` и systemd-файл `cgb-postgres-api.service`. Не помещайте `.env` в каталог статического сайта.

Проверка: `GET /api/v1/health`. Для production обязательны HTTPS, длинный случайный `JWT_SECRET` и TLS-соединение с PostgreSQL.

