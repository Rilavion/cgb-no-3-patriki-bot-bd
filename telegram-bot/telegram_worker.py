#!/usr/bin/env python3
"""ЦГБ №3 · Telegram-уведомитель для автономного PostgreSQL."""

from __future__ import annotations

import html
import json
import os
import re
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

VERSION = "1.1.0"
STOP = threading.Event()
BOT_TZ = os.environ.get("TIMEZONE", "Europe/Moscow")
SITE_URL = os.environ.get("CGB_SITE_URL", "https://cgb3patriki.ru").rstrip("/")
POLL_SECONDS = max(2, int(os.environ.get("TELEGRAM_POLL_SECONDS", "4")))


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env(Path(__file__).with_name(".env"))
BOT_TZ = os.environ.get("TIMEZONE", BOT_TZ)
SITE_URL = os.environ.get("CGB_SITE_URL", SITE_URL).rstrip("/")
POLL_SECONDS = max(2, int(os.environ.get("TELEGRAM_POLL_SECONDS", str(POLL_SECONDS))))


def log(*parts: object) -> None:
    print(datetime.now(timezone.utc).isoformat(timespec="seconds"), *parts, flush=True)


class HttpFailure(RuntimeError):
    pass


def json_request(url: str, method: str = "GET", payload=None, headers=None, timeout: int = 35, opener=None):
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        req_headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        open_request = opener.open if opener is not None else urllib.request.urlopen
        with open_request(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw.decode("utf-8")) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")[:1000]
        raise HttpFailure(f"HTTP {exc.code}: {raw}") from exc
    except urllib.error.URLError as exc:
        raise HttpFailure(f"Network: {exc.reason}") from exc


class PostgresDb:
    IDENT = re.compile(r"^[a-z_][a-z0-9_]*$", re.I)

    def __init__(self, database_url: str):
        self.connection = psycopg.connect(database_url, autocommit=True, row_factory=dict_row)
        self.lock = threading.Lock()

    def ident(self, value: str) -> str:
        if not self.IDENT.fullmatch(str(value or "")):
            raise ValueError("invalid SQL identifier")
        return '"' + str(value) + '"'

    @staticmethod
    def adapt(value):
        return Jsonb(value) if isinstance(value, (dict, list)) else value

    def filters(self, params: dict | None):
        clauses, values = [], []
        ignored = {"select", "order", "limit", "offset", "on_conflict"}
        for column, raw in (params or {}).items():
            if column in ignored:
                continue
            text = str(raw)
            op, _, payload = text.partition(".")
            if op == "eq":
                clauses.append(f"{self.ident(column)} = %s"); values.append(payload)
            elif op == "lt":
                clauses.append(f"{self.ident(column)} < %s"); values.append(payload)
            elif op == "lte":
                clauses.append(f"{self.ident(column)} <= %s"); values.append(payload)
            elif op == "gt":
                clauses.append(f"{self.ident(column)} > %s"); values.append(payload)
            elif op == "gte":
                clauses.append(f"{self.ident(column)} >= %s"); values.append(payload)
            elif op == "in" and payload.startswith("(") and payload.endswith(")"):
                items = [item for item in payload[1:-1].split(",") if item]
                clauses.append(f"{self.ident(column)} = any(%s)"); values.append(items)
            elif op == "is" and payload == "null":
                clauses.append(f"{self.ident(column)} is null")
            else:
                raise ValueError(f"unsupported filter: {column}={raw}")
        return clauses, values

    def get(self, table: str, params=None):
        params = params or {}
        columns = params.get("select", "*")
        select = "*" if columns == "*" else ",".join(self.ident(x.strip()) for x in columns.split(","))
        clauses, values = self.filters(params)
        query = f"select {select} from public.{self.ident(table)}"
        if clauses:
            query += " where " + " and ".join(clauses)
        if params.get("order"):
            orders = []
            for item in str(params["order"]).split(","):
                bits = item.split(".")
                orders.append(self.ident(bits[0]) + (" desc" if "desc" in bits[1:] else " asc"))
            query += " order by " + ",".join(orders)
        if params.get("limit"):
            query += " limit %s"; values.append(int(params["limit"]))
        with self.lock, self.connection.cursor() as cur:
            cur.execute(query, values)
            return cur.fetchall()

    def patch(self, table: str, values: dict, params=None, return_rows: bool = True):
        entries = list(values.items())
        args = [self.adapt(value) for _, value in entries]
        sets = [f"{self.ident(key)} = %s" for key, _ in entries]
        clauses, filter_values = self.filters(params)
        if not clauses:
            raise ValueError("refusing update without filters")
        query = f"update public.{self.ident(table)} set " + ",".join(sets)
        query += " where " + " and ".join(clauses)
        if return_rows:
            query += " returning *"
        with self.lock, self.connection.cursor() as cur:
            cur.execute(query, args + filter_values)
            return cur.fetchall() if return_rows else []

    def upsert(self, table: str, values, conflict: str):
        rows = values if isinstance(values, list) else [values]
        if not rows:
            return []
        columns = list(dict.fromkeys(key for row in rows for key in row))
        conflicts = [item.strip() for item in conflict.split(",") if item.strip()]
        updates = [column for column in columns if column not in conflicts]
        args = []
        tuples = []
        for row in rows:
            tuples.append("(" + ",".join(["%s"] * len(columns)) + ")")
            args.extend(self.adapt(row.get(column)) for column in columns)
        query = f"insert into public.{self.ident(table)} (" + ",".join(map(self.ident, columns)) + ") values " + ",".join(tuples)
        query += " on conflict (" + ",".join(map(self.ident, conflicts)) + ") "
        query += ("do update set " + ",".join(f"{self.ident(c)}=excluded.{self.ident(c)}" for c in updates)) if updates else "do nothing"
        query += " returning *"
        with self.lock, self.connection.cursor() as cur:
            cur.execute(query, args)
            return cur.fetchall()


class TelegramApi:
    def __init__(self, token: str):
        self.base = "https://api.telegram.org/bot" + token
        proxy_url = os.environ.get("OUTBOUND_PROXY_URL", "").strip()
        self.opener = None
        if proxy_url:
            self.opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
            )

    def call(self, method: str, payload=None, timeout: int = 35):
        result = json_request(self.base + "/" + method, "POST", payload or {}, timeout=timeout, opener=self.opener)
        if not result or not result.get("ok"):
            description = (result or {}).get("description", "unknown Telegram error")
            raise HttpFailure(description)
        return result.get("result")


ROUTES = {
    "exams": {"icon": "📊", "label": "Экзамены · вердикты", "page": "tests.html"},
    "promotion": {"icon": "⭐", "label": "Повышения", "page": "requests-review.html"},
    "applications": {"icon": "📨", "label": "Эл. заявления / восстановления", "page": "apps.html"},
    "dismissal": {"icon": "⛔", "label": "Увольнения", "page": "requests-review.html"},
    "vacations": {"icon": "🏖", "label": "Отпуск IC / OOC", "page": "requests-review.html"},
    "leave": {"icon": "🕒", "label": "Отгулы", "page": "requests-review.html"},
}
REQUEST_LABELS = {
    "promotion": "Повышение", "restoration": "Восстановление", "dismissal": "Увольнение",
    "vacation_ic": "Отпуск IC", "vacation_ooc": "Отпуск OOC", "leave": "Отгул",
}
STATUS_LABELS = {
    "pending": "Ожидает рассмотрения", "new": "Новая", "approved": "Одобрено",
    "rejected": "Отклонено", "archived": "Архив", "withdrawn": "Отозвано",
}


def e(value) -> str:
    return html.escape(str(value if value not in (None, "") else "—"), quote=True)


def value_first(values: dict, *keys: str):
    for key in keys:
        val = values.get(key)
        if val not in (None, "", False):
            return val
    return None


def format_date(value) -> str:
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(ZoneInfo(BOT_TZ)).strftime("%d.%m.%Y · %H:%M")
    except Exception:
        return str(value)


def status_icon(status: str) -> str:
    return {"approved": "✅", "rejected": "❌", "archived": "🗄", "withdrawn": "↩️"}.get(status, "🔔")


def format_message(row: dict) -> str:
    route = row.get("route_key") or ""
    meta = ROUTES.get(route, {"icon": "🔔", "label": route or "Уведомление", "page": "index.html"})
    payload = row.get("payload") or {}
    kind = row.get("event_kind") or ""
    source = row.get("source_table") or ""
    link = f'{SITE_URL}/{meta["page"]}'
    if source == "requests":
        link = f"{SITE_URL}/requests-review.html"

    if source == "manual" or kind == "test":
        return (
            f'<b>🔔 Проверка Telegram-уведомлений</b>\n\n'
            f'Маршрут: <b>{e(meta["label"])}</b>\n'
            f'Если вы видите это сообщение — тема подключена правильно.\n\n'
            f'<a href="{e(link)}">Открыть сайт ЦГБ №3</a>'
        )

    if route == "exams":
        passed = payload.get("passed") is True
        verdict = "СДАН" if passed else "НЕ СДАН"
        icon = "✅" if passed else "❌"
        percent = payload.get("percent")
        score = payload.get("score")
        total = payload.get("total")
        result = (f"{round(float(percent))}%" if percent is not None else
                  (f"{score} из {total}" if score is not None and total is not None else "—"))
        lines = [
            f"<b>📊 Экзамен · {icon} {verdict}</b>", "",
            f'<b>Тест:</b> {e(payload.get("test_title") or "Экзамен")}',
            f'<b>Сотрудник:</b> {e(payload.get("fio"))}',
            f'<b>Статик:</b> <code>{e(payload.get("static_id"))}</code>',
            f'<b>Результат:</b> {e(result)}',
        ]
        if payload.get("discord"):
            lines.append(f'<b>Discord:</b> {e(payload.get("discord"))}')
        if payload.get("finished_at"):
            lines.append(f'<b>Завершён:</b> {e(format_date(payload.get("finished_at")))}')
        lines.extend(["", f'<a href="{e(link)}">Открыть результаты на сайте</a>'])
        return "\n".join(lines)

    if source == "applications":
        status = str(payload.get("status") or "new")
        is_verdict = kind.startswith("status_")
        title = (f'{status_icon(status)} Вердикт по электронному заявлению' if is_verdict
                 else "📨 Новое электронное заявление")
        lines = [
            f"<b>{title}</b>", "",
            f'<b>Тип:</b> {e(payload.get("app_type") or "Электронное заявление")}',
            f'<b>Заявитель:</b> {e(payload.get("submitter_name") or payload.get("submitter_discord"))}',
        ]
        if is_verdict:
            lines.append(f'<b>Статус:</b> {e(STATUS_LABELS.get(status, status))}')
            if payload.get("responded_by_name"):
                lines.append(f'<b>Рассмотрел:</b> {e(payload.get("responded_by_name"))}')
            if payload.get("reject_reason"):
                lines.append(f'<b>Причина:</b> {e(payload.get("reject_reason"))}')
        lines.extend(["", f'<a href="{e(link)}">Открыть заявления на сайте</a>'])
        return "\n".join(lines)

    values = payload.get("values") if isinstance(payload.get("values"), dict) else {}
    request_kind = payload.get("kind") or ""
    label = REQUEST_LABELS.get(request_kind, request_kind or meta["label"])
    status = str(payload.get("status") or "pending")
    is_verdict = kind.startswith("status_")
    title = (f'{status_icon(status)} Вердикт · {label}' if is_verdict else f'{meta["icon"]} Новая заявка · {label}')
    lines = [
        f"<b>{e(title)}</b>", "",
        f'<b>Номер:</b> <code>{e(payload.get("code"))}</code>',
        f'<b>Сотрудник:</b> {e(payload.get("submitter_fio"))}',
        f'<b>Статик:</b> <code>{e(payload.get("submitter_static"))}</code>',
    ]
    if payload.get("submitter_discord"):
        lines.append(f'<b>Discord:</b> {e(payload.get("submitter_discord"))}')
    if is_verdict:
        lines.append(f'<b>Статус:</b> {e(STATUS_LABELS.get(status, status))}')
        if payload.get("verdict_by_name"):
            lines.append(f'<b>Рассмотрел:</b> {e(payload.get("verdict_by_name"))}')
        if payload.get("verdict_comment"):
            lines.append(f'<b>Комментарий:</b> {e(payload.get("verdict_comment"))}')
    else:
        period_from = value_first(values, "from_date", "date_from", "leave_date")
        period_to = value_first(values, "to_date", "date_to")
        reason = value_first(values, "reason", "dismiss_reason", "comment")
        target = value_first(values, "target_rank", "desired_rank")
        if period_from:
            period = str(period_from) + ((" — " + str(period_to)) if period_to else "")
            lines.append(f'<b>Период:</b> {e(period)}')
        if target:
            lines.append(f'<b>Желаемая должность:</b> {e(target)}')
        if reason:
            lines.append(f'<b>Причина:</b> {e(reason)}')
    lines.extend(["", f'<a href="{e(link)}">Открыть заявку на сайте</a>'])
    return "\n".join(lines)


class Worker:
    def __init__(self, database: PostgresDb, telegram: TelegramApi, bot: dict):
        self.db = database
        self.tg = telegram
        self.bot = bot
        self.settings = {"enabled": False, "routes": {}}
        self.settings_loaded = 0.0
        self.update_offset = 0
        self.last_heartbeat = 0.0
        self.last_error = None

    def refresh_settings(self, force=False):
        if not force and time.time() - self.settings_loaded < 12:
            return self.settings
        rows = self.db.get("telegram_settings", {"select": "*", "id": "eq.1", "limit": "1"})
        self.settings = rows[0] if rows else {"enabled": False, "routes": {}}
        self.settings_loaded = time.time()
        return self.settings

    def heartbeat(self, online=True, error=None):
        now = datetime.now(timezone.utc).isoformat()
        row = {
            "id": 1, "online": bool(online), "bot_id": self.bot.get("id"),
            "bot_username": self.bot.get("username"),
            "bot_name": self.bot.get("first_name"), "version": VERSION,
            "last_seen_at": now, "last_error": (str(error)[:500] if error else None), "updated_at": now,
        }
        try:
            self.db.upsert("telegram_bot_status", [row], "id")
            self.last_heartbeat = time.time()
        except Exception as exc:
            log("HEARTBEAT error:", exc)

    def register_topic(self, message: dict, explicit_name=None):
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return
        thread_id = message.get("message_thread_id") or 0
        created = message.get("forum_topic_created") or {}
        topic_title = explicit_name or created.get("name") or ("Основная тема" if int(thread_id) in (0, 1) else f"Тема {thread_id}")
        sender = message.get("from") or {}
        sender_name = " ".join(x for x in [sender.get("first_name"), sender.get("last_name")] if x).strip() or sender.get("username")
        row = {
            "chat_id": chat_id, "thread_id": thread_id, "chat_title": chat.get("title") or chat.get("username") or str(chat_id),
            "topic_title": topic_title[:160], "chat_type": chat.get("type"), "is_forum": bool(chat.get("is_forum")),
            "registered_by_name": sender_name, "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
        self.db.upsert("telegram_topics", [row], "chat_id,thread_id")
        log("TOPIC registered:", row["chat_title"], "→", row["topic_title"], "thread", thread_id)

    def reply(self, message: dict, text: str):
        chat_id = (message.get("chat") or {}).get("id")
        if chat_id is None:
            return
        payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
        thread_id = message.get("message_thread_id") or 0
        if int(thread_id) not in (0, 1):
            payload["message_thread_id"] = thread_id
        self.tg.call("sendMessage", payload)

    def handle_update(self, update: dict):
        message = update.get("message") or update.get("channel_post")
        if not message:
            return
        if message.get("forum_topic_created"):
            self.register_topic(message)
        text = str(message.get("text") or "").strip()
        register = re.match(r"^/register(?:@\w+)?(?:\s+(.+))?$", text, re.I | re.S)
        if register:
            name = (register.group(1) or "").strip() or None
            self.register_topic(message, name)
            thread_id = message.get("message_thread_id") or 0
            self.reply(message, f"✅ <b>Тема зарегистрирована</b>\nChat ID: <code>{e((message.get('chat') or {}).get('id'))}</code>\nTopic ID: <code>{e(thread_id)}</code>")
        elif re.match(r"^/status(?:@\w+)?$", text, re.I):
            enabled = bool(self.refresh_settings(True).get("enabled"))
            self.reply(message, "✅ <b>Telegram-уведомитель работает</b>\nОтправка уведомлений: " + ("включена" if enabled else "выключена на сайте"))
        elif re.match(r"^/chatid(?:@\w+)?$", text, re.I):
            self.reply(message, f"Chat ID: <code>{e((message.get('chat') or {}).get('id'))}</code>\nTopic ID: <code>{e(message.get('message_thread_id') or 0)}</code>")

    def discovery_loop(self):
        while not STOP.is_set():
            try:
                updates = self.tg.call("getUpdates", {
                    "offset": self.update_offset, "timeout": 25,
                    "allowed_updates": ["message", "channel_post", "my_chat_member"],
                }, timeout=32) or []
                for update in updates:
                    self.update_offset = max(self.update_offset, int(update.get("update_id", 0)) + 1)
                    try:
                        self.handle_update(update)
                    except Exception as exc:
                        log("UPDATE error:", exc)
            except Exception as exc:
                self.last_error = str(exc)
                log("getUpdates error:", exc)
                STOP.wait(5)

    def destination(self, route_key: str):
        routes = self.settings.get("routes") if isinstance(self.settings.get("routes"), dict) else {}
        route = routes.get(route_key) if isinstance(routes.get(route_key), dict) else None
        if not route or route.get("enabled") is False or not route.get("chat_id"):
            return None
        return route

    def claim(self, row: dict):
        current = row.get("status") or "pending"
        result = self.db.patch("telegram_notifications", {
            "status": "sending", "error_message": None
        }, {"id": "eq." + str(row["id"]), "status": "eq." + current})
        return result[0] if result else None

    def process_one(self, row: dict):
        destination = self.destination(row.get("route_key"))
        if not destination:
            if row.get("status") != "waiting_config":
                self.db.patch("telegram_notifications", {
                    "status": "waiting_config", "error_message": "Маршрут не настроен"
                }, {"id": "eq." + str(row["id"])}, False)
            return
        claimed = self.claim(row)
        if not claimed:
            return
        try:
            payload = {
                "chat_id": destination["chat_id"], "text": format_message(row), "parse_mode": "HTML",
                "link_preview_options": {"is_disabled": True},
            }
            thread_id = int(destination.get("thread_id") or 0)
            if thread_id not in (0, 1):
                payload["message_thread_id"] = thread_id
            sent = self.tg.call("sendMessage", payload)
            self.db.patch("telegram_notifications", {
                "status": "sent", "telegram_message_id": sent.get("message_id"),
                "sent_at": datetime.now(timezone.utc).isoformat(), "error_message": None,
            }, {"id": "eq." + str(row["id"])}, False)
            log("SENT", row.get("route_key"), row.get("event_key"))
        except Exception as exc:
            attempts = int(row.get("attempts") or 0) + 1
            delay = min(3600, 30 * (2 ** max(0, attempts - 1)))
            self.db.patch("telegram_notifications", {
                "status": "error", "attempts": attempts, "error_message": str(exc)[:500],
                "next_attempt_at": (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat(),
            }, {"id": "eq." + str(row["id"])}, False)
            self.last_error = str(exc)
            log("SEND error:", row.get("event_key"), exc)

    def queue_once(self):
        settings = self.refresh_settings()
        if not settings.get("enabled"):
            return
        rows = self.db.get("telegram_notifications", {
            "select": "*", "status": "in.(pending,error,waiting_config)",
            "attempts": "lt.5", "order": "created_at.asc", "limit": "20",
        })
        now = datetime.now(timezone.utc)
        for row in rows:
            next_at = row.get("next_attempt_at")
            if next_at:
                try:
                    if datetime.fromisoformat(str(next_at).replace("Z", "+00:00")) > now:
                        continue
                except Exception:
                    pass
            self.process_one(row)

    def run(self):
        self.tg.call("deleteWebhook", {"drop_pending_updates": False})
        try:
            self.tg.call("setMyCommands", {"commands": [
                {"command": "register", "description": "Подключить текущую тему"},
                {"command": "status", "description": "Проверить работу уведомителя"},
                {"command": "chatid", "description": "Показать ID группы и темы"},
            ]})
        except Exception as exc:
            log("COMMANDS warning:", exc)
        self.heartbeat(True)
        threading.Thread(target=self.discovery_loop, name="telegram-updates", daemon=True).start()
        while not STOP.is_set():
            try:
                self.queue_once()
                if time.time() - self.last_heartbeat > 25:
                    self.heartbeat(True, self.last_error)
                    self.last_error = None
            except Exception as exc:
                self.last_error = str(exc)
                log("QUEUE error:", exc)
            STOP.wait(POLL_SECONDS)
        self.heartbeat(False)


def main() -> int:
    required = ["TELEGRAM_BOT_TOKEN", "DATABASE_URL"]
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        log("Не заданы переменные:", ", ".join(missing))
        return 2
    db = PostgresDb(os.environ["DATABASE_URL"])
    telegram = TelegramApi(os.environ["TELEGRAM_BOT_TOKEN"])
    try:
        bot = telegram.call("getMe")
    except Exception as exc:
        log("Telegram token / connection error:", exc)
        return 3
    log("START", "@" + str(bot.get("username") or bot.get("id")), "version", VERSION)
    worker = Worker(db, telegram, bot)
    worker.run()
    log("STOP")
    return 0


def stop_handler(_signum, _frame):
    STOP.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    sys.exit(main())
