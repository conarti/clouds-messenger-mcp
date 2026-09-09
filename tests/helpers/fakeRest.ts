/**
 * Подложный REST для проверок, которым нужна справка о профилях и ничего больше.
 *
 * Отвечает только на POST справки и считает обращения: именно счётчиком доказывается, что
 * кэш профилей работает, а батч не разъезжается на вызов о каждом человеке. Остальные
 * методы порта падают намеренно: проверка, случайно ушедшая в KDC, обязана падать громко,
 * а не получать правдоподобную пустоту.
 */
import type { KdcKey, RestClient } from '../../src/transport/types.js';
import { makeProfilesResponse, type ProfileFixture } from './readFixtures.js';

export interface FakeRestCall {
  path: string;
  huids: string[];
}

export class FakeProfilesRest implements RestClient {
  /** Ушедшие запросы: длина это число обращений, содержимое это состав батчей */
  readonly calls: FakeRestCall[] = [];

  private readonly profiles: Map<string, ProfileFixture>;

  constructor(profiles: readonly ProfileFixture[] = []) {
    this.profiles = new Map(profiles.map((profile) => [profile.huid, profile]));
  }

  async getJson<T>(path: string): Promise<T> {
    throw new Error(`подложный REST не отвечает на GET ${path}`);
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const requested = (body as { huids?: unknown }).huids;
    const huids = Array.isArray(requested) ? requested.map(String) : [];
    this.calls.push({ path, huids });
    const known = huids.flatMap((huid) => {
      const profile = this.profiles.get(huid);
      return profile === undefined ? [] : [profile];
    });
    return makeProfilesResponse([known]) as T;
  }

  async getKdcKeys(): Promise<KdcKey[]> {
    throw new Error('подложный REST не отвечает на запрос ключей');
  }
}
