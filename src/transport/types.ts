/** Запись KDC: публичное тело ключа под своим идентификатором */
export interface KdcKey {
  key_id: string;
  algo: string;
  kind: string;
  body: string;
}

/**
 * Порт REST. KDC живёт здесь, а не в крипто: сборка проводного URL это знание транспорта,
 * и крипто зовёт `getKdcKeys(ids)`, не зная ни базы, ни пути (Принцип 1).
 */
export interface RestClient {
  getJson<T>(path: string, query?: Record<string, string>): Promise<T>;
  getKdcKeys(ids: readonly string[]): Promise<KdcKey[]>;
}
