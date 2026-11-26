// Мини-разбор аргументов командной строки для dev-инструментов.
// Поддерживает `--key=value`, `--key value`, флаги `--flag` и повторяемые
// опции (`--press a@10 --press b@20` превращаются в массив).

import { pathToFileURL } from 'node:url';

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    let name;
    let value;
    if (eq !== -1) {
      name = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }
    if (name in result) result[name] = [...[].concat(result[name]), value];
    else result[name] = value;
  }
  if (rest.length) result._ = rest;
  return result;
}

/** Числовая опция: NaN/пусто → fallback. */
export function intOption(value, fallback) {
  if (value === undefined || value === null || value === true || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

/** Список чисел из `--flag 1,2,3` или повторяемого `--flag 1 --flag 2`. */
export function intListOption(value, fallback = []) {
  if (value === undefined) return fallback;
  const items = [].concat(value);
  const result = [];
  for (const item of items) {
    for (const part of String(item).split(',')) {
      const text = part.trim();
      if (!text) continue;
      const number = Number(text);
      if (!Number.isFinite(number)) throw new Error(`Ожидалось число в списке, пришло: ${text}`);
      result.push(Math.trunc(number));
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

/** Запущен ли модуль как CLI (а не импортирован). */
export function isMain(moduleUrl) {
  const script = process.argv[1];
  return Boolean(script) && pathToFileURL(script).href === moduleUrl;
}

export function printHelp(text) {
  process.stdout.write(text.trimStart() + '\n');
}

/** Ошибка «движок ещё не готов»: compare/fetch должны отвечать понятно. */
export class NotReadyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotReadyError';
  }
}

export function formatError(error) {
  if (!error) return 'неизвестная ошибка';
  if (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(error.message ?? '')) {
    return `${error.message.split('\n')[0]} (модуль ещё не создан — инструмент готов и запустится после его появления)`;
  }
  return error.message ?? String(error);
}
