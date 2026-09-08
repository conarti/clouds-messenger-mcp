/**
 * Греп-гейт: правила, которые нельзя проверить вызовом, проверяются чтением исходников.
 *
 * Каждое правило здесь охраняет обещание, которое ломается тихо и обнаруживается поздно:
 * посторонний байт в stdout убивает сессию MCP целиком, слово провода в верхнем слое
 * прорастает связностью, `skip` в тесте превращает зелёный прогон в декорацию. Обычный
 * тест такое поймать не может, потому что ломается не поведение, а свойство исходника.
 *
 * Гейт читает дерево на диске, а не собранный пакет: правило про исходник должно падать
 * до сборки, иначе оно опаздывает ровно на ту сборку, в которой нарушение уже уехало.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Сам гейт из проверок по образцам исключён: он обязан содержать искомые образцы, иначе
 * искать было бы нечем. Это единственный файл с таким правом, и он целиком перед глазами.
 */
const GATE_FILE = 'tests/unit/observability.test.ts';

/**
 * stdout принадлежит stdio-транспорту MCP: там идёт JSON-RPC, и любая посторонняя строка
 * делает поток неразбираемым. Писать туда имеет право только точка входа (она отдаёт
 * транспорт SDK), а логгер держит рядом объяснение, почему пишет исключительно в stderr.
 */
const STDOUT_OWNERS = ['src/util/logger.ts', 'src/index.ts'];

/**
 * Микросекундная метка это идентификатор чужого протокола (yandex-messenger-mcp). Здесь
 * идентификатор события это `sync_id` и UUID; появление метки означает, что вместе с
 * каркасным файлом приехало и допущение об арифметике курсора (Pre-mortem 1).
 */
const FOREIGN_IDENTIFIER = 'timestamp_mcs';

/** Мнимая зелень: пропущенный, единственный или недописанный тест это не доказательство */
const FORBIDDEN_IN_TESTS = ['test.skip(', 'it.skip(', 'describe.skip(', '.only(', 'TODO', 'FIXME'];

/** Однострочный комментарий; URL внутри строки не считается, потому что якорь это начало строки */
const LINE_COMMENT = /^\s*\/\//;

/** Длинное тире и двойной дефис: следы чужой типографики в тексте комментариев */
const EM_DASH = '\u2014';
const DOUBLE_HYPHEN = ' -- ';

/**
 * Слова провода. Принцип 1: знание о проводе концентрируется внизу и убывает вверх, поэтому
 * имена событий и топиков живут только там, где кадр собирается и разбирается.
 */
const WIRE_LITERALS = [
  'groupchat:',
  'events_history',
  'message_new',
  'get_chat_list_base_changes',
  'get_unread_counters',
  'thread_list',
  'event_info',
  'authenticate',
  'phx_reply',
];

/** Слои, которым слова провода разрешены: кодек, протокол, крипто и адреса с версиями */
const WIRE_LITERAL_HOMES = ['src/transport/', 'src/protocol/', 'src/crypto/', 'src/config/'];

/** Слои, ради которых Принцип 1 и написан: инструменты и сборка ответа */
const UPPER_LAYERS = ['src/mcp/', 'src/chat/'];

interface SourceFile {
  /** Путь от корня проекта в едином виде: он уходит в текст падения */
  path: string;
  lines: string[];
  /**
   * Те же строки с вырезанными блочными комментариями (символы заменены пробелами, номера
   * строк сохранены). Принцип 1 говорит про литералы на проводе, а не про пояснения к ним:
   * запрет упоминать событие в комментарии сделал бы код непонятным, ничего не выиграв.
   */
  code: string[];
}

function collectTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTypeScriptFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
}

function load(root: string): SourceFile[] {
  return collectTypeScriptFiles(join(PROJECT_ROOT, root))
    .map((full) => {
      const source = readFileSync(full, 'utf8');
      return {
        path: relative(PROJECT_ROOT, full).split(sep).join('/'),
        lines: source.split('\n'),
        code: stripBlockComments(source).split('\n'),
      };
    })
    .sort((first, second) => first.path.localeCompare(second.path));
}

const SOURCE_FILES = load('src');
const TEST_FILES = load('tests');

/** Нарушение называется файлом, строкой и самой строкой: иначе гейт сообщает «где-то плохо» */
function violations(files: readonly SourceFile[], isViolation: (line: string) => boolean): string[] {
  return files.flatMap((file) =>
    file.lines
      .map((text, index) => ({ text, number: index + 1 }))
      .filter((line) => isViolation(line.text))
      .map((line) => `${file.path}:${line.number}: ${line.text.trim()}`),
  );
}

function wireLiteralViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    file.code.flatMap((text, index) =>
      WIRE_LITERALS.filter((literal) => text.includes(literal)).map(
        (literal) => `${file.path}:${index + 1}: ${literal}`,
      ),
    ),
  );
}

function without(files: readonly SourceFile[], paths: readonly string[]): SourceFile[] {
  return files.filter((file) => !paths.includes(file.path));
}

function under(files: readonly SourceFile[], prefixes: readonly string[]): SourceFile[] {
  return files.filter((file) => prefixes.some((prefix) => file.path.startsWith(prefix)));
}

describe('гейт: дерево вообще прочитано', () => {
  /* Пустой список файлов сделал бы зелёными все проверки разом, ничего не проверив */
  it('видит исходники и тесты', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(10);
    expect(TEST_FILES.length).toBeGreaterThan(10);
    expect(TEST_FILES.map((file) => file.path)).toContain(GATE_FILE);
  });
});

describe('гейт: stdout принадлежит транспорту MCP', () => {
  it('никто, кроме логгера и точки входа, не пишет в stdout и в консоль', () => {
    const found = violations(
      without(SOURCE_FILES, STDOUT_OWNERS),
      (line) => line.includes('console.') || line.includes('process.stdout'),
    );

    expect(found).toEqual([]);
  });
});

describe('гейт: чужие допущения', () => {
  it('идентификатор события не микросекундная метка', () => {
    expect(violations(SOURCE_FILES, (line) => line.includes(FOREIGN_IDENTIFIER))).toEqual([]);
  });
});

describe('гейт: тесты доказывают, а не изображают', () => {
  it('в тестах нет пропусков, единственных тестов и недописанных мест', () => {
    const found = violations(without(TEST_FILES, [GATE_FILE]), (line) =>
      FORBIDDEN_IN_TESTS.some((pattern) => line.includes(pattern)),
    );

    expect(found).toEqual([]);
  });
});

describe('гейт: стиль исходников', () => {
  it('комментарии только блочные', () => {
    expect(violations([...SOURCE_FILES, ...TEST_FILES], (line) => LINE_COMMENT.test(line))).toEqual([]);
  });

  it('в исходниках нет длинного тире и двойного дефиса', () => {
    const found = violations(
      SOURCE_FILES,
      (line) => line.includes(EM_DASH) || line.includes(DOUBLE_HYPHEN),
    );

    expect(found).toEqual([]);
  });
});

describe('гейт: знание о проводе не поднимается вверх', () => {
  it('слова провода встречаются только в кодеке, протоколе, крипто и конфиге', () => {
    const outsideHomes = SOURCE_FILES.filter(
      (file) => !WIRE_LITERAL_HOMES.some((home) => file.path.startsWith(home)),
    );

    expect(wireLiteralViolations(outsideHomes)).toEqual([]);
  });

  /* Отдельная проверка ровно там, где нарушение вероятнее всего: слой инструментов */
  it('инструменты и сборка ответа не знают ни одного слова провода', () => {
    expect(wireLiteralViolations(under(SOURCE_FILES, UPPER_LAYERS))).toEqual([]);
  });
});
