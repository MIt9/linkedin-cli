# LinkedIn CLI Bridge (розширення Chrome)

Розширення з'єднується з локальним сервісом CLI по WebSocket: `ws://127.0.0.1:<порт>/ext`. Типовий порт: `47851`.

## Зміна порту

1. Змініть порт у CLI: `linkedin config set port N`, потім перезапустіть сервіс (`linkedin service restart`).
2. Відкрийте popup розширення, введіть той самий порт у полі поруч із «Service» і натисніть Save.
   Порт має бути цілим числом від 1024 до 65535. Розширення одразу перепідключається, перезавантажувати його не треба.

Порт зберігається в `chrome.storage.local` (ключ `cli_port`). Якщо значення пошкоджене, використовується `47851`.

## Якщо порт зайнятий

- Сервіс не стартує або `linkedin service status` показує помилку: порт займає інша програма.
  Знайдіть її: `lsof -nP -iTCP:47851 -sTCP:LISTEN`.
- Виберіть вільний порт: `linkedin config set port 47900`, перезапустіть сервіс і збережіть той самий порт у popup.
- Popup показує «Not connected»: перевірте `linkedin service status` і що порт у popup збігається з портом сервісу.
  Розширення повторює спробу кожні 30 с, або натисніть Reconnect.

## ID розширення

Фіксований завдяки полю `key` у `manifest.json`: **`pkgbinmnaaomjnafdfocndamjhaaoffl`**.
Його (і версію) показує popup; на нього посилаються `linkedin doctor` та інсталятор.
Приватний ключ не потрібен для unpacked-встановлення і видалений; публічний ключ у `manifest.json`.

Увага: ID змінився (раніше `inedfhfajmninghbbipmfkiamfhclohe`). Після оновлення до 0.2.0 відкрийте `chrome://extensions`,
видаліть старе розширення (Remove) і додайте папку `extension/` знову (Load unpacked). Reload може не підхопити новий ID, тому Remove + Load unpacked надійніше.

Сервіс може перезавантажити розширення повідомленням `{type:'reload'}` (`chrome.runtime.reload()`, без відповіді).

## Тести

`node --test extension/test/protocol.test.js`
