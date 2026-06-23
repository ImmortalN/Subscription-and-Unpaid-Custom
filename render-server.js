import os
import html
import logging
import requests
import time
import sys
import re
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

CLICKUP_TOKEN = os.getenv("CLICKUP_API_TOKEN")
INTERCOM_TOKEN = os.getenv("INTERCOM_ACCESS_TOKEN")
INTERCOM_BASE = "https://api.intercom.io"
INTERCOM_VERSION = "Unstable"
DEFAULT_FOLDER_ID = 4725328
INTERCOM_OWNER_ID = int(os.getenv("INTERCOM_OWNER_ID", 0))
INTERCOM_AUTHOR_ID = int(os.getenv("INTERCOM_AUTHOR_ID", 0))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
log = logging.getLogger(__name__)

cu = requests.Session()
cu.headers.update({"Authorization": CLICKUP_TOKEN, "Content-Type": "application/json"})

ic = requests.Session()
ic.headers.update({
    "Authorization": f"Bearer {INTERCOM_TOKEN}",
    "Accept": "application/json",
    "Intercom-Version": INTERCOM_VERSION,
    "Content-Type": "application/json"
})


def parse_task_name(name: str):
    name = name.strip()
    match = re.match(r'^([A-Za-z][A-Za-z0-9\s]*?)\s*(?:v)?(\d+\.\d+(?:\.\d+)?)', name, re.IGNORECASE)
    if match:
        product = match.group(1).strip()
        version = match.group(2)
        return product, version
    return name, None


def get_all_tasks_from_source(source_id):
    all_tasks = []
    page = 0
    max_pages = 50

    while page < max_pages:
        params = {
            "subtasks": "false",
            "include_closed": "true",
            "order_by": "created",
            "reverse": "true",      # Новые сначала
            "page": page,
            "include_timl": "true"
        }

        page_has_tasks = False
        for endpoint in [f"list/{source_id}/task", f"view/{source_id}/task"]:
            url = f"https://api.clickup.com/api/v2/{endpoint}"
            try:
                r = cu.get(url, params=params)
                if r.status_code == 200:
                    tasks = r.json().get("tasks", [])
                    if tasks:
                        all_tasks.extend(tasks)
                        log.info(f"✅ Получено {len(tasks)} задач (страница {page})")
                        page_has_tasks = True
                    break
            except Exception as e:
                log.error(f"Ошибка {endpoint}: {e}")

        if not page_has_tasks:
            break
        page += 1
        time.sleep(0.8)

    # Дополнительная сортировка по дате создания (новые сверху)
    all_tasks.sort(key=lambda t: int(t.get("date_created") or 0), reverse=True)
    
    log.info(f"✅ Всего задач из ClickUp: {len(all_tasks)}")
    return all_tasks


def get_existing_articles_in_folder(folder_id):
    existing = {}
    page = 1
    target_folder_str = str(folder_id)

    log.info(f"Загружаем существующие гайды из Intercom...")

    while True:
        r = ic.get(f"{INTERCOM_BASE}/internal_articles", params={"page": page, "per_page": 50})
        if r.status_code != 200:
            log.error(f"Intercom error: {r.status_code}")
            break

        articles = r.json().get("data", [])
        if not articles:
            break

        for art in articles:
            if str(art.get("folder_id") or "") == target_folder_str:
                title = art.get("title", "").strip()
                existing[title.lower()] = art

        if page >= r.json().get("pages", {}).get("total_pages", 1):
            break
        page += 1
        time.sleep(0.2)

    log.info(f"✅ Найдено существующих гайдов: {len(existing)}")
    return existing


def get_latest_body(article_id):
    r = ic.get(f"{INTERCOM_BASE}/internal_articles/{article_id}")
    if r.status_code == 200:
        return r.json().get('body', '')
    log.warning(f"Не удалось получить body для {article_id}")
    return ''


def get_or_create_changelog(product: str, existing_articles):
    changelog_title = f"{product} Changelog"
    clean_key = changelog_title.lower()

    if clean_key in existing_articles:
        art = existing_articles[clean_key]
        log.info(f"✅ Используем существующий → {changelog_title}")
        return art['id'], art.get('body', ''), art

    log.info(f"Создаём новый changelog → {changelog_title}")
    payload = {
        "title": changelog_title,
        "body": f"<h1>{changelog_title}</h1>",
        "owner_id": INTERCOM_OWNER_ID,
        "author_id": INTERCOM_AUTHOR_ID,
        "folder_id": DEFAULT_FOLDER_ID
    }

    r = ic.post(f"{INTERCOM_BASE}/internal_articles", json=payload)
    if r.status_code in (200, 201):
        data = r.json()
        existing_articles[clean_key] = data
        return data['id'], data.get('body', ''), data
    else:
        log.error(f"❌ Не удалось создать: {r.text}")
        return None, None, None


def build_release_section(version: str, date_str: str, subtasks):
    lines = [f"<h2>{version} ({date_str})</h2>"]
    if subtasks:
        lines.append("<ul>")
        for sub in subtasks:
            sub_name = html.escape(sub.get("name", "").strip())
            if sub_name:
                lines.append(f"  <li>{sub_name}</li>")
        lines.append("</ul>")
    lines.append("<br>")
    return "\n".join(lines)


def update_changelog(article_id: str, version: str, new_section: str):
    current_body = get_latest_body(article_id)
    
    if f"<h2>{version}" in current_body:
        log.info(f"Версия {version} уже есть — пропускаем")
        return False

    # Всегда вставляем в самое начало (после <h1>)
    if "<h1>" in current_body:
        parts = current_body.split("</h1>", 1)
        new_body = parts[0] + "</h1>\n\n" + new_section + (parts[1] if len(parts) > 1 else "")
    else:
        new_body = f"<h1>Changelog</h1>\n\n{new_section}" + current_body

    r = ic.put(f"{INTERCOM_BASE}/internal_articles/{article_id}", json={"body": new_body[:50000]})

    if r.status_code in (200, 201, 204):
        log.info(f"✅ Добавлена версия {version} (в начало)")
        return True
    else:
        log.error(f"❌ Ошибка обновления: {r.status_code}")
        return False


def get_clickup_task(task_id):
    r = cu.get(f"https://api.clickup.com/api/v2/task/{task_id}",
               params={"subtasks": "true", "include_subtasks": "true"})
    return r.json() if r.status_code == 200 else None


def process_release_task(main_task, existing_articles):
    name = main_task.get("name", "").strip()
    if not name:
        return

    product, version = parse_task_name(name)
    subtasks = main_task.get("subtasks", [])
    date_created_ms = main_task.get("date_created")
    date_str = datetime.fromtimestamp(int(date_created_ms) / 1000).strftime('%d.%m.%Y') if date_created_ms else ""

    article_id, _, _ = get_or_create_changelog(product, existing_articles)
    if not article_id:
        return

    if version:
        new_section = build_release_section(version, date_str, subtasks)
        update_changelog(article_id, version, new_section)
    else:
        log.info(f"Создаём отдельный гайд: {name}")
        body = f"<h1>{html.escape(name)}</h1>"
        if subtasks:
            body += "<ul>" + "".join(f"<li>{html.escape(s.get('name',''))}</li>" for s in subtasks if s.get('name')) + "</ul>"
        payload = {
            "title": name,
            "body": body,
            "owner_id": INTERCOM_OWNER_ID,
            "author_id": INTERCOM_AUTHOR_ID,
            "folder_id": DEFAULT_FOLDER_ID
        }
        r = ic.post(f"{INTERCOM_BASE}/internal_articles", json=payload)
        if r.status_code in (200, 201):
            log.info("✅ Отдельный гайд создан")


def main():
    folder_id = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_FOLDER_ID)
    source_id = sys.argv[2] if len(sys.argv) > 2 else "8cjzjmb-30872"

    current_folder = int(folder_id) if str(folder_id).isdigit() else DEFAULT_FOLDER_ID

    log.info(f"🚀 Запуск синхронизации Changelog'ов | Folder: {current_folder} | Source: {source_id}")

    tasks = get_all_tasks_from_source(source_id)
    if not tasks:
        log.error("Не удалось получить задачи")
        return

    existing_articles = get_existing_articles_in_folder(current_folder)

    for task in tasks:
        full_task = get_clickup_task(task["id"])
        if full_task:
            process_release_task(full_task, existing_articles)
            time.sleep(1.0)

    log.info("🎉 Синхронизация завершена!")


if __name__ == "__main__":
    main()
