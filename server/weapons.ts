import { readFileSync, existsSync } from 'node:fs';

export type WeaponNames = Record<string, string>;

export function loadWeaponNames(path: string): WeaponNames {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

export function weaponName(names: WeaponNames, cause: string | null | undefined): string | null {
  if (!cause) return null;
  return names[cause] ?? cause.replace(/^Id\.Item\./, '').replace(/_/g, ' ');
}
