/**
 * Конфигурация semantic-release. Порядок плагинов фиксирован намеренно:
 * commit-analyzer определяет тип бампа из сообщений коммитов, затем
 * release-notes-generator и changelog готовят текст и файл, затем npm публикует
 * пакет, затем github публикует релиз с заметками, и последним git возвращает
 * CHANGELOG.md и package.json в репозиторий. Версии сверены с реестром npm
 * командой `npm view <пакет> version` на 2026-09-08, а не взяты по памяти:
 * semantic-release 25.0.9, @semantic-release/commit-analyzer 13.0.1,
 * @semantic-release/release-notes-generator 14.1.1, @semantic-release/changelog 7.0.0,
 * @semantic-release/npm 13.1.5, @semantic-release/github 12.0.9,
 * @semantic-release/git 11.0.1.
 *
 * Явного конфига не требует ни один плагин: changelog пишет CHANGELOG.md в корне,
 * npm публикует пакет из корня (поле `files: ["dist"]` в package.json уже ограничивает
 * содержимое тарбола, поэтому `pkgRoot` не переопределяем), git по умолчанию коммитит
 * CHANGELOG.md и package.json сообщением `chore(release): ... [skip ci]`.
 *
 * Версионирование 0.x. Пока публичный контракт инструментов не устоялся, пакет
 * держим в ветке версий 0.x: ломающее изменение бампает MINOR, а не MAJOR.
 * Сам semantic-release так не умеет, его FAQ прямо выносит правила major zero
 * за рамки проекта, поэтому правило задано явно через releaseRules ниже.
 *
 * Ручной шаг перед первым релизом (делается один раз, при выпуске, не при подготовке):
 * поставить базовый тег на коммит в main, иначе semantic-release захардкодит первую
 * версию в 1.0.0, минуя всю ветку 0.x:
 *   git tag v0.1.0 && git push origin v0.1.0
 * После этого первый прогон посчитает бамп от 0.1.0 обычным semver-инкрементом.
 * Когда API будет готов к стабилизации, правило breaking -> minor снимается отдельным
 * коммитом, и следующее ломающее изменение выпустит 1.0.0.
 */
export default {
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        /*
         * Ветка версий 0.x: ломающее изменение даёт minor, а не major.
         * Правило временное, снять при готовности объявить 1.0.0.
         */
        releaseRules: [{ breaking: true, release: 'minor' }],
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm',
    '@semantic-release/github',
    '@semantic-release/git',
  ],
};
