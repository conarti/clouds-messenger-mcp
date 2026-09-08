/**
 * Время в Клаудс приезжает строкой ISO-8601 (`timestamp`, `inserted_at`, `since`),
 * а курсор истории это UUID `sync_id`, а не арифметическая метка. Поэтому здесь только
 * разбор и сравнение ISO: никакой арифметики над курсором тут быть не должно, иначе
 * появится соблазн «сдвинуть границу на единицу», как это делалось на микросекундных метках.
 */

/** Разбирает ISO-8601. Непонятная строка это отказ, а не молчаливый NaN дальше по коду */
export function parseIso(value: string): Date {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) {
    throw new TypeError(`timestamp: не разобран ISO-8601 "${value}"`);
  }
  return new Date(millis);
}

/** Приводит к ISO-8601 в UTC: на проводе и в выдаче инструментов формат один */
export function toIso(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('timestamp: невалидная дата');
  }
  return date.toISOString();
}
