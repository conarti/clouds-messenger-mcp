# [0.5.0](https://github.com/conarti/clouds-messenger-mcp/compare/v0.4.0...v0.5.0) (2026-10-01)


### Bug Fixes

* автоустановка Chromium при старте сервера ([2644a87](https://github.com/conarti/clouds-messenger-mcp/commit/2644a874fe2a29a406c9cd742660575ee89ef20a)), closes [#1](https://github.com/conarti/clouds-messenger-mcp/issues/1)


### Features

* ответ на сообщение и связь reply при чтении ([3d752eb](https://github.com/conarti/clouds-messenger-mcp/commit/3d752eb00ca4228dfcdbc764b4efc3e9d16e876c)), closes [#3](https://github.com/conarti/clouds-messenger-mcp/issues/3)
* отправка в тред и чтение по адресу треда ([2681e25](https://github.com/conarti/clouds-messenger-mcp/commit/2681e2540aa6f7c6bcd1e108c561a20eed024c02)), closes [#2](https://github.com/conarti/clouds-messenger-mcp/issues/2)
* отправка сообщения одним вызовом ([1482244](https://github.com/conarti/clouds-messenger-mcp/commit/14822440baa23eab3aa511d0492eb5b2acddf236)), closes [#6](https://github.com/conarti/clouds-messenger-mcp/issues/6)
* упоминания людей в сообщении ([11073ee](https://github.com/conarti/clouds-messenger-mcp/commit/11073eefd87a626ae3cfdfbcb7b7f09919850795)), closes [#7](https://github.com/conarti/clouds-messenger-mcp/issues/7)


### BREAKING CHANGES

* send_message больше не принимает confirm и confirm_token
и не возвращает статусы draft и confirm_rejected. Ответ всегда status sent.

# [0.4.0](https://github.com/conarti/clouds-messenger-mcp/compare/v0.3.0...v0.4.0) (2026-10-01)


### Features

* чужие треды в get_thread и признак треда в сообщениях ([3b46cda](https://github.com/conarti/clouds-messenger-mcp/commit/3b46cda53337765be1ae686edcd4fd37f8b90b93)), closes [#5](https://github.com/conarti/clouds-messenger-mcp/issues/5)

# [0.3.0](https://github.com/conarti/clouds-messenger-mcp/compare/v0.2.1...v0.3.0) (2026-09-09)


### Features

* имена собеседников, поиск людей, ссылки и упоминания ([f04e16a](https://github.com/conarti/clouds-messenger-mcp/commit/f04e16a9865e41e569323f00e05cbdf0758fa4c4))

## [0.2.1](https://github.com/conarti/clouds-messenger-mcp/compare/v0.2.0...v0.2.1) (2026-09-09)


### Bug Fixes

* ожидание ключей профиля после первого входа ([bf6ffe3](https://github.com/conarti/clouds-messenger-mcp/commit/bf6ffe3684998f8eacc6367783123ad8f3c25ee4))

# [0.2.0](https://github.com/conarti/clouds-messenger-mcp/compare/v0.1.0...v0.2.0) (2026-09-09)


### Features

* закрытие сокета после простоя ([ae4bf68](https://github.com/conarti/clouds-messenger-mcp/commit/ae4bf683e485f4de90ea760a6a93b4f981654974))
