/*
  SQL fragment helpers. Every value that reaches a SQL string goes through
  one of these — there is no string interpolation of raw user input anywhere
  in the engine.
*/

export function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function sqlNum(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`non-finite number in SQL: ${value}`);
  return String(value);
}

export function sqlBool(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function sqlDate(isoDate: string): string {
  if (!ISO_DATE.test(isoDate)) throw new Error(`not an ISO date: ${isoDate}`);
  return `DATE ${sqlStr(isoDate)}`;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sqlIdent(name: string): string {
  if (!IDENT.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return name;
}

/** Paths are embedded as single-quoted literals with forward slashes. */
export function sqlPath(p: string): string {
  return sqlStr(p.replaceAll("\\", "/"));
}
