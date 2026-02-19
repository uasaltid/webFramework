# webFramework

Modular multi-domain HTTP framework & runtime platform for Node.js  
Модульный multi-domain HTTP-фреймворк и runtime-платформа для Node.js

---

## 🚀 Overview

**webFramework** — это серверная платформа для запуска нескольких доменов (multi-domain) с динамической загрузкой backend-модулей.

Особенности:

- 🧱 Ядро HTTP сервера (`builder.js`)
- 🚀 Bootstrap & orchestrator (`server.js`)
- 🌍 Поддержка нескольких доменов через `./web/<domain>/`
- 🔄 Динамический import backend
- 📦 Авто-загрузка проектов из GitHub (через GitHub API)
- 🔌 Система lifecycle hooks (pluginmanager)
- 📝 Логирование
- 📊 Аналитика
- 🧠 Redis integration
- ⚙ Глобальная конфигурация через `defaults.conf`

Это не просто HTTP-фреймворк — это мини runtime-платформа для изоляции и запуска backend-проектов.

---

# 🇷🇺 Документация

## 📂 Структура проекта
```

├── server.js
├── builder.js
├── pluginmanager.js
├── logger.js
├── redis.js
├── analytics.js
├── defaults.conf
└── web/
└── <domain>/
├── params.conf
└── backend file (например index.js)```


---

## 🧠 Как работает запуск

При старте:

1. `server.js` вызывает `builder.js`
2. Сканируется папка `./web`
3. Для каждого домена:
   - читается `params.conf`
   - создаются symlink’и на `builder.js`, `logger.js`, `redis.js`
   - загружается backend через dynamic `import`
4. Запускается `analytics.js`
5. Вызываются lifecycle hooks

---

## 🌍 Multi-Domain модель

Каждый домен — это отдельная папка:
```./web/example.com/```

Внутри должен быть:
```params.conf

---

## ⚙ Пример params.conf

```json
{
  "backend": "index.js"
}```
Если backend указан — он будет импортирован динамически:
```import("./web/example.com/index.js")```

##📦 Авто-загрузка из GitHub

Можно указать репозиторий:
```json
{
  "backend": "index.js",
  "repository": {
    "author": "username",
    "name": "repository",
    "token": "optional_github_token"
  }
}```

Тогда фреймворк:
1. Скачает src/ из GitHub API
2. Разместит файлы в ./web/<repo>.<domain>/
3. Создаст symlink'и
4. Запустит backend
Это позволяет использовать GitHub как источник деплоя.

##🌐 Глобальная конфигурация

```builder.js``` читает:

```./defaults.conf```


Файл в формате JSON.

Пример:

```JSON
{
  "port": 3003,
  "address": "0.0.0.0",
  "https": false,
  "cors": {
    "origin": "*",
    "headers": "*",
    "methods": "*"
  }
}```

##🔌 Lifecycle Hooks

Через pluginmanager вызываются события:
```loading-started```
```loading-save-call```
```loading-save-call-error```
```github-download```
```signal-sigint```
```loading-end```
Это позволяет расширять поведение фреймворка.

## 📦 Установка
```git clone https://github.com/uasaltid/webFramework.git
cd webFramework
npm install```

##▶ Запуск
```node server.js```

##🧩 Минимальный backend пример
```./web/example.com/index.js```
```js
import builder from "../builder.js"

export default builder("example.com")```

##🏗 Архитектура
```server.js        → Bootstrap & Domain Loader
   ↓
builder.js       → HTTP core
   ↓
pluginmanager    → Hooks
   ↓
logger           → Logging
redis            → Cache
analytics        → Metrics```
